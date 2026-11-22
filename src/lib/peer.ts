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

export type Route = 'local' | 'internet' | 'unknown'

// Works out whether the two browsers found a direct path on the same network,
// or are going out to the internet and back. The second is usually much slower.
export async function routeOf(pc: RTCPeerConnection | undefined | null): Promise<Route> {
  if (!pc) return 'unknown'
  try {
    const stats = await pc.getStats()
    let pairId = ''
    stats.forEach((s) => {
      if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId
    })
    let pair: any = pairId ? stats.get(pairId) : null
    if (!pair) {
      stats.forEach((s) => {
        if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || s.selected)) pair = s
      })
    }
    if (!pair) return 'unknown'
    const local = stats.get(pair.localCandidateId)
    const remote = stats.get(pair.remoteCandidateId)
    if (!local || !remote) return 'unknown'
    const isPrivate = (a?: string) =>
      !a || a.endsWith('.local') || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|fe80:|fd|fc)/i.test(a)
    if (local.candidateType === 'host' && remote.candidateType === 'host') return 'local'
    if ((local.candidateType === 'host' || local.candidateType === 'prflx') && isPrivate(remote.address || remote.ip)) return 'local'
    return 'internet'
  } catch {
    return 'unknown'
  }
}
