'use strict';
// Browser APIs index.html needs that jsdom doesn't provide (or that Node
// can't do "for real"), wired up so the REAL app code — completely
// unmodified — actually runs against them:
//
//   - window.WebSocket   -> the real `ws` npm package, pointed at a real
//                           spawned server.js (see server-runner.js). Not
//                           mocked at all; this is a genuine signaling round
//                           trip over a real socket.
//   - window.fetch       -> Node's built-in fetch, for the one-time
//                           /api/ice-config request index.html fires at load.
//   - window.RTCPeerConnection / data channels -> genuinely mocked, since
//                           there's no real WebRTC in Node. Two mock peer
//                           connections "find" each other via the SDP payload
//                           they exchange over the real WebSocket signaling
//                           relay (a plain string tag, not a real SDP blob),
//                           then hand out a paired MockDataChannel that
//                           behaves like a real one (async, JSON strings in,
//                           JSON strings out) — see _link() below for the
//                           exact handshake this mirrors.
const WebSocket = require('ws');

let pcCounter = 0;
// sdp tag -> the MockRTCPeerConnection that registered it via
// setLocalDescription. Looked up by the OTHER side's setRemoteDescription to
// find its peer. Process-global is fine: every scenario runs as its own
// `node` process (see run-all.js), so there's never cross-scenario bleed.
const sdpRegistry = new Map();

class MockDataChannel {
  constructor(label) {
    this.label = label;
    this.readyState = 'connecting';
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this._remote = null;
  }
  // Pairs this channel with its counterpart and opens BOTH — but only after
  // giving the caller a chance to assign onopen/onmessage first (see the
  // queueMicrotask/setTimeout split in MockRTCPeerConnection._link: this is
  // called synchronously from within a microtask, and the actual "open"
  // transition is deferred a macrotask further out, specifically so a
  // handler assigned in response to `ondatachannel` is guaranteed to already
  // be in place before onopen fires).
  _pairWith(remote) {
    this._remote = remote;
    remote._remote = this;
  }
  _open() {
    if (this.readyState !== 'connecting') return;
    this.readyState = 'open';
    if (typeof this.onopen === 'function') this.onopen();
  }
  send(data) {
    if (this.readyState !== 'open' || !this._remote) return;
    const remote = this._remote;
    setTimeout(() => {
      if (remote.readyState === 'open' && typeof remote.onmessage === 'function') remote.onmessage({ data });
    }, 0);
  }
  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    const remote = this._remote;
    if (typeof this.onclose === 'function') this.onclose();
    if (remote && remote.readyState !== 'closed') remote.close();
  }
}

class MockRTCPeerConnection {
  constructor(config) {
    this._id = ++pcCounter;
    this.iceConnectionState = 'new';
    this.localDescription = null;
    this.remoteDescription = null;
    this.ondatachannel = null;
    this.onicecandidate = null; // never actually fired — see file header comment, candidates aren't needed for this mock
    this.oniceconnectionstatechange = null;
    this._dc = null;
    this._peer = null;
  }
  createDataChannel(label) {
    this._dc = new MockDataChannel(label);
    return this._dc;
  }
  createOffer() {
    return Promise.resolve({ type: 'offer', sdp: 'mock-offer:' + this._id });
  }
  createAnswer() {
    return Promise.resolve({ type: 'answer', sdp: 'mock-answer:' + this._id });
  }
  setLocalDescription(desc) {
    this.localDescription = desc;
    sdpRegistry.set(desc.sdp, this);
    return Promise.resolve();
  }
  setRemoteDescription(desc) {
    this.remoteDescription = desc;
    // Resolve on a microtask, same as a real RTCPeerConnection promise would
    // — the link/ondatachannel work below relies on running strictly after
    // the caller's own .then() chain has had a chance to attach handlers
    // (e.g. playerHandleSignal sets pc.ondatachannel BEFORE calling this).
    return Promise.resolve().then(() => {
      const peer = sdpRegistry.get(desc.sdp);
      if (peer) this._link(peer);
    });
  }
  addIceCandidate() {
    return Promise.resolve();
  }
  _link(peer) {
    if (this._peer === peer) return; // already linked from the other direction
    this._peer = peer;
    peer._peer = this;
    this.iceConnectionState = 'connected';
    peer.iceConnectionState = 'connected';
    // Whichever side already has a data channel (the offerer, always — see
    // hostBeginConnectionTo's pc.createDataChannel call, made before the
    // offer is even created) hands the other side its paired counterpart via
    // ondatachannel, exactly like a real answerer receives one.
    if (peer._dc && !this._dc) {
      const localDc = new MockDataChannel(peer._dc.label);
      localDc._pairWith(peer._dc);
      this._dc = localDc;
      if (typeof this.ondatachannel === 'function') this.ondatachannel({ channel: localDc });
    } else if (this._dc && peer._dc && !this._dc._remote) {
      this._dc._pairWith(peer._dc);
    }
    // Actually open both sides now, a macrotask later — strictly after the
    // ondatachannel dispatch above (and whatever handler assignment it
    // triggered) has fully run.
    const dc = this._dc, peerDc = peer._dc;
    setTimeout(() => {
      if (dc) dc._open();
      if (peerDc) peerDc._open();
    }, 0);
  }
  close() {
    this.iceConnectionState = 'closed';
    if (this._dc) this._dc.close();
  }
  // Test-only helper (not part of the real RTCPeerConnection API): simulates
  // an abrupt network failure — WiFi drop, backgrounded tab, etc. — the way
  // index.html's own oniceconnectionstatechange handlers expect to observe
  // it, then lets the app's real code decide what to do about it.
  __simulateIceFailure() {
    this.iceConnectionState = 'failed';
    if (typeof this.oniceconnectionstatechange === 'function') this.oniceconnectionstatechange();
  }
}

function installMocks(window) {
  window.WebSocket = WebSocket;
  // Node 18+ has a global fetch; index.html only ever calls it with a
  // relative path ('/api/ice-config'), so resolve against the window's own
  // location before handing off to the real implementation.
  const nodeFetch = global.fetch;
  window.fetch = (url, opts) => nodeFetch(new URL(url, window.location.href).toString(), opts);
  window.RTCPeerConnection = MockRTCPeerConnection;
  // Tracks every mock peer connection this window has created, in creation
  // order — lets test code reach in and simulate a dropped connection (see
  // device.js's killConnection) without index.html needing any test-only
  // hooks of its own for this.
  window.__mockRTCConnections = [];
  const RealCtor = window.RTCPeerConnection;
  window.RTCPeerConnection = function (config) {
    const pc = new RealCtor(config);
    window.__mockRTCConnections.push(pc);
    return pc;
  };
  window.RTCPeerConnection.prototype = RealCtor.prototype;
  // navigator.clipboard/share aren't used by any scenario below, but a few
  // App.* functions touch them opportunistically (copy/share the invite
  // link) — stub them out so calling those paths never throws.
  if (!window.navigator.clipboard) {
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText: () => Promise.resolve() },
      configurable: true
    });
  }
}

module.exports = { installMocks, MockRTCPeerConnection };
