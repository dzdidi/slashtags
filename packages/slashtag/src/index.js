import EventEmitter from 'events'
import { DHT } from 'dht-universal'
import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'
import Corestore from 'corestore'
import RAM from 'random-access-memory'
import goodbye from 'graceful-goodbye'
import HashMap from 'turbo-hash-map'
import { SlashDrive } from '@synonymdev/slashdrive'
import Debug from 'debug'
import { SlashURL } from './url.js'

import { SlashProtocol } from './protocol.js'
import { randomBytes, createKeyPair } from './crypto.js'
import { catchConnection } from './utils.js'

export { SlashProtocol, SlashURL }

export const DRIVE_KEYS = {
  profile: 'profile.json'
}

const debug = Debug('slashtags:slashtag')

export class Slashtag extends EventEmitter {
  /**
   *
   * @param {object} opts
   * @param {string} [opts.url]
   * @param {Uint8Array} [opts.key]
   * @param {import('./interfaces').KeyPair} [opts.keyPair]
   * @param {import('corestore')} [opts.store]
   * @param {Array<typeof import('./protocol').SlashProtocol>} [opts.protocols]
   * @param {object} [opts.swarmOpts]
   * @param {string[]} [opts.swarmOpts.relays]
   * @param {Array<{host: string; port: number}>} [opts.swarmOpts.bootstrap]
   */
  constructor (opts = {}) {
    super()

    this.keyPair = opts.keyPair
    this.remote = !this.keyPair
    this.url = opts.url ? new SlashURL(opts.url) : null
    this.key = opts.keyPair?.publicKey || opts.key || this.url?.slashtag.key
    if (!this.key) throw new Error('Missing keyPair or key')

    this.url = this.url || new SlashURL(this.key)

    this._swarmOpts = opts.swarmOpts
    const store = opts.store || new Corestore(RAM)
    this.store = store.namespace(this.key)

    this._drives = new HashMap()

    if (!this.remote) {
      this._protocols = new Map()
      opts.protocols?.forEach((p) => this.protocol(p))
    }

    this.closed = false

    // Gracefully shutdown
    goodbye(() => {
      !this.closed && debug('gracefully closing Slashtag')
      return this.close()
    })
  }

  /**
   * Sets up and resolves the publicDrive for this Slashtag.
   */
  async ready () {
    if (this._ready) return true

    const dht = await DHT.create({ ...this._swarmOpts })
    this.swarm = new Hyperswarm({
      ...this._swarmOpts,
      keyPair: this.keyPair,
      dht
    })
    this.swarm.on('connection', this._handleConnection.bind(this))
    this._ready = true

    this.publicDrive = await this.drive({
      key: this.key,
      keyPair: this.keyPair
    })

    debug('Slashtag is ready', {
      key: b4a.toString(this.key, 'hex'),
      remote: this.remote
    })
  }

  async listen () {
    if (this.remote) throw new Error('Cannot listen on a remote slashtag')
    await this.ready()

    // @ts-ignore After the ready() call, this.swarm is set
    return this.swarm.listen()
  }

  /**
   * Connect to a remote Slashtag.
   *
   * @param {Uint8Array | SlashURL | string} key
   * @returns {Promise<{connection: SecretStream, peerInfo:PeerInfo}>}
   */
  async connect (key) {
    if (this.remote) throw new Error('Cannot connect from a remote slashtag')
    if (typeof key === 'string') key = new SlashURL(key).slashtag.key
    if (key instanceof SlashURL) key = key.slashtag.key

    if (b4a.equals(key, this.key)) throw new Error('Cannot connect to self')
    await this.ready()

    let connection = this.swarm?._allConnections.get(key)
    if (connection) {
      return {
        connection,
        peerInfo: this.swarm?.peers.get(b4a.toString(key, 'hex'))
      }
    }

    connection = this.swarm && catchConnection(this.swarm, key)

    this.swarm?.joinPeer(key)
    return connection
  }

  /**
   * Registers a protocol if it wasn't already, and get and instance of it for this Slashtag.
   *
   * @template {typeof SlashProtocol} P
   * @param {P} Protocol
   * @returns {InstanceType<P>}
   */
  protocol (Protocol) {
    if (this.remote) {
      throw new Error('Cannot register protocol on a remote slashtag')
    }

    // @ts-ignore
    const name = Protocol.protocol

    let protocol = this._protocols?.get(name)
    if (protocol) return protocol
    protocol = new Protocol({ slashtag: this })
    this._protocols?.set(name, protocol)
    return protocol
  }

  /**
   * Sets the Slashtag's profile in its public drive
   *
   * @param {Object} profile
   */
  async setProfile (profile) {
    await this.ready()
    return this.publicDrive?.put(
      DRIVE_KEYS.profile,
      b4a.from(JSON.stringify(profile))
    )
  }

  /**
   * Returns the profile of the Slashtag from the public drive
   *
   * @returns {Promise<object | null>}
   */
  async getProfile () {
    await this.ready()
    const result = await this.publicDrive?.get(DRIVE_KEYS.profile)
    if (!result) return null
    return JSON.parse(b4a.toString(result))
  }

  /**
   * Creates a private drive namespaced to this slashtag's key,
   * or resolves a private drives shared by other slashtags.
   * See {@link SlashDrive} for more information.
   *
   * @param {object} opts
   * @param {string} [opts.name]
   * @param {boolean} [opts.encrypted]
   * @param {Uint8Array} [opts.key]
   * @param {import('./interfaces').KeyPair} [opts.keyPair]
   * @param {Uint8Array} [opts.encryptionKey]
   * @returns {Promise<SlashDrive>}
   */
  async drive (opts) {
    await this.ready()

    const drive = new SlashDrive({ ...opts, store: this.store })
    await drive.ready()

    const existing = this._drives.get(drive.key)
    if (existing) return existing
    this._drives.set(drive.key, drive)

    this._setupDiscovery(drive)

    await drive.update()
    return drive
  }

  /**
   *
   * @param {SlashDrive} drive
   * @param {*} opts
   */
  async _setupDiscovery (drive, opts = { server: true, client: true }) {
    // TODO enable customizing the discovery option
    this.swarm?.join(drive.discoveryKey, opts)

    const done = await drive.findingPeers()
    this.swarm?.flush().then(done, done)

    debug('Setting up discovery done', b4a.toString(drive.discoveryKey, 'hex'))
  }

  async close () {
    if (this.closed) return
    this.closed = true
    this.emit('close')
    if (!this.swarm) return
    await this.swarm?.destroy()
    await this.store.close()
    debug('Slashtag closed', b4a.toString(this.key, 'hex'))
  }

  /**
   * Generates a Slashtags KeyPair, randomly or optionally from primary key and a name.
   *
   * @param {Uint8Array} [primaryKey]
   * @param {string} [name]
   */
  static createKeyPair (primaryKey = randomBytes(), name = '') {
    return createKeyPair(primaryKey, name)
  }

  /**
   * Augment Server and client's connections with Slashtag protocols and peerInfo.slashtag.
   *
   * @param {*} socket
   * @param {PeerInfo} peerInfo
   */
  async _handleConnection (socket, peerInfo) {
    this.store.replicate(socket)
    peerInfo.slashtag = new Slashtag({
      key: peerInfo.publicKey,
      swarmOpts: this._swarmOpts
    })

    const info = {
      local: this.url.toString(),
      remote: peerInfo.slashtag.url.toString()
    }

    debug('Swarm connection OPENED', info)
    socket.on('error', function (/** @type {Error} */ err) {
      debug('Swarm connection ERRORED', err, info)
    })
    socket.on('close', function () {
      debug('Swarm connection CLOSED', info)
      peerInfo.slashtag.close()
    })

    this._setupProtocols(socket, peerInfo)
    this.emit('connection', socket, peerInfo)
  }

  /**
   *
   * @param {SecretStream} socket
   * @param {PeerInfo} peerInfo
   */
  _setupProtocols (socket, peerInfo) {
    if (!this._protocols) return
    for (const protocol of this._protocols.values()) {
      protocol.createChannel(socket, peerInfo)
    }
  }
}

/**
 * @typedef {import('./interfaces').PeerInfo } PeerInfo
 * @typedef {import('./interfaces').SecretStream } SecretStream
 */
