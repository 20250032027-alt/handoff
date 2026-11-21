import Peer, { type PeerOptions } from 'peerjs'

// Signaling goes through the free public PeerJS server by default. Only the
// handshake goes through it; the footage goes directly between the two browsers.
// Set VITE_PEER_HOST (and friends) to use your own PeerServer instead.
export function peerOptions(): PeerOptions {
  const env = import.meta.env
  const opts: PeerOptions = {
    debug: 1,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' },
      ],
    },
  }
  if (env.VITE_PEER_HOST) {
    opts.host = env.VITE_PEER_HOST
    opts.port = Number(env.VITE_PEER_PORT || 443)
    opts.path = env.VITE_PEER_PATH || '/'
    opts.secure = env.VITE_PEER_SECURE !== 'false'
  }
  return opts
}

export function makePeer(id?: string): Peer {
  return id ? new Peer(id, peerOptions()) : new Peer(peerOptions())
}
