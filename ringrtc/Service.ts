//
// Copyright (C) 2020 Signal Messenger, LLC.
// All rights reserved.
//
// SPDX-License-Identifier: GPL-3.0-only
//

/* tslint:disable max-classes-per-file */

const os = require('os');

// tslint:disable-next-line no-var-requires no-require-imports
const Native = require('../../build/' + os.platform() + '/libringrtc.node');

export default class RingRTCType {
  callManager: CallManager;
  call?: Call;
  // Set by UX
  handleIncomingCall: ((call: Call) => Promise<CallSettings>) | null = null;
  handleIgnoredCall:
    | ((remoteUserId: UserId, reason: CallIgnoredReason) => void)
    | null = null;

  constructor() {
    this.callManager = new Native.CallManager() as CallManager;
    this.pollEvery(50);
  }

  private pollEvery(intervalMs: number): void {
    this.callManager.poll(this);
    setTimeout(() => {
      this.pollEvery(intervalMs);
    }, intervalMs);
  }

  // Called by UX
  startOutgoingCall(
    remoteUserId: UserId,
    isVideoCall: boolean,
    settings: CallSettings
  ): Call {
    const callId = null;
    const incoming = false;
    this.call = new Call(
      this.callManager,
      remoteUserId,
      callId,
      incoming,
      settings,
      CallState.Prering
    );
    this.callManager.call(remoteUserId, isVideoCall);
    return this.call;
  }

  // Called by Rust
  onStartOutgoingCall(remoteUserId: UserId, callId: CallId): void {
    const call = this.call;
    if (!call || call.remoteUserId !== remoteUserId || !call.settings) {
      return;
    }

    call.callId = callId;
    this.proceed(callId, call.settings);
  }

  // Called by Rust
  onStartIncomingCall(remoteUserId: UserId, callId: CallId): void {
    const incoming = true;
    const call = new Call(
      this.callManager,
      remoteUserId,
      callId,
      incoming,
      null,
      CallState.Prering
    );
    // Callback to UX not set
    const handleIncomingCall = this.handleIncomingCall;
    if (!handleIncomingCall) {
      call.hangup();
      return;
    }
    this.call = call;

    // tslint:disable no-floating-promises
    (async () => {
      const settings = await handleIncomingCall(call);
      if (!settings) {
        call.hangup();
        return;
      }
      call.settings = settings;
      this.proceed(callId, settings);
    })();
  }

  private proceed(callId: CallId, settings: CallSettings): void {
    const enableForking = true;
    // tslint:disable no-floating-promises
    (async () => {
      // This is a silly way of causing a deadlock.
      // tslint:disable-next-line await-promise
      await 0;
      this.callManager.proceed(
        callId,
        settings.localDeviceId,
        settings.iceServer.username || '',
        settings.iceServer.password || '',
        settings.iceServer.urls,
        settings.hideIp,
        enableForking
      );
    })();
  }

  // Called by Rust
  onCallState(remoteUserId: UserId, state: CallState): void {
    const call = this.call;
    if (!call || call.remoteUserId !== remoteUserId) {
      return;
    }
    call.state = state;

    // Because you might have been enabled before you were accepted.
    // We should probably do this in native code instead.
    if (call.state === CallState.Accepted) {
      // Silly hack to avoid deadlock.
      // tslint:disable no-floating-promises
      (async () => {
        // tslint:disable-next-line await-promise
        await 0;
        this.callManager.sendVideoStatus(call.outgoingVideoEnabled);
      })();
    }
  }

  // Called by Rust
  onCallEnded(remoteUserId: UserId, reason: string) {
    const call = this.call;
    if (!call || call.remoteUserId !== remoteUserId) {
      return;
    }

    // Send the end reason first because setting the state triggers
    // call.handleStateChanged, which may look at call.endedReason.
    call.endedReason = reason;
    call.state = CallState.Ended;
  }

  onRemoteVideoEnabled(remoteUserId: UserId, enabled: boolean): void {
    const call = this.call;
    if (!call || call.remoteUserId !== remoteUserId) {
      return;
    }

    if (call.handleRemoteVideoEnabled) {
      call.handleRemoteVideoEnabled(enabled);
    }
  }

  renderVideoFrame(width: number, height: number, buffer: ArrayBuffer): void {
    const call = this.call;
    if (!call) {
      return;
    }

    if (!!this.call?.renderVideoFrame) {
      this.call?.renderVideoFrame(width, height, buffer);
    }
  }

  // Called by Rust
  onSendOffer(
    remoteUserId: UserId,
    remoteDeviceId: DeviceId,
    callId: CallId,
    broadcast: boolean,
    offerType: OfferType,
    sdp: string
  ): void {
    const message = new CallingMessage();
    message.offer = new OfferMessage();
    message.offer.callId = callId;
    message.offer.type = offerType;
    message.offer.sdp = sdp;
    this.sendSignaling(remoteUserId, remoteDeviceId, broadcast, message);
  }

  // Called by Rust
  onSendAnswer(
    remoteUserId: UserId,
    remoteDeviceId: DeviceId,
    callId: CallId,
    broadcast: boolean,
    sdp: string
  ): void {
    const message = new CallingMessage();
    message.answer = new AnswerMessage();
    message.answer.callId = callId;
    message.answer.sdp = sdp;
    this.sendSignaling(remoteUserId, remoteDeviceId, broadcast, message);
  }

  // Called by Rust
  onSendIceCandidates(
    remoteUserId: UserId,
    remoteDeviceId: DeviceId,
    callId: CallId,
    broadcast: boolean,
    candidates: Array<IceCandidateMessage>
  ): void {
    const message = new CallingMessage();
    message.iceCandidates = [];
    for (const candidate of candidates) {
      const copy = new IceCandidateMessage();
      copy.callId = callId;
      copy.mid = candidate.mid;
      copy.midIndex = 0;
      copy.sdp = candidate.sdp;
      message.iceCandidates.push(copy);
    }
    this.sendSignaling(remoteUserId, remoteDeviceId, broadcast, message);
  }

  // Called by Rust
  onSendLegacyHangup(
    remoteUserId: UserId,
    remoteDeviceId: DeviceId,
    callId: CallId,
    broadcast: boolean,
    hangupType: HangupType,
    deviceId: DeviceId | null
  ): void {
    const message = new CallingMessage();
    message.legacyHangup = new HangupMessage();
    message.legacyHangup.callId = callId;
    message.legacyHangup.type = hangupType;
    message.legacyHangup.deviceId = deviceId || 0;
    this.sendSignaling(remoteUserId, remoteDeviceId, broadcast, message);
  }

  // Called by Rust
  onSendHangup(
    remoteUserId: UserId,
    remoteDeviceId: DeviceId,
    callId: CallId,
    broadcast: boolean,
    hangupType: HangupType,
    deviceId: DeviceId | null
  ): void {
    const message = new CallingMessage();
    message.hangup = new HangupMessage();
    message.hangup.callId = callId;
    message.hangup.type = hangupType;
    message.hangup.deviceId = deviceId || 0;
    this.sendSignaling(remoteUserId, remoteDeviceId, broadcast, message);
  }

  // Called by Rust
  onSendBusy(
    remoteUserId: UserId,
    remoteDeviceId: DeviceId,
    callId: CallId,
    broadcast: boolean
  ): void {
    const message = new CallingMessage();
    message.busy = new BusyMessage();
    message.busy.callId = callId;
    this.sendSignaling(remoteUserId, remoteDeviceId, broadcast, message);
  }

  // Called by Rust
  onLog(_message: string): void {
    // This is really verbose.
    // console.log(`Calling: From RingRTC: '${message}'`);
  }

  private sendSignaling(
    remoteUserId: UserId,
    remoteDeviceId: DeviceId,
    broadcast: boolean,
    message: CallingMessage
  ) {
    const call = this.call;
    if (!call || call.remoteUserId !== remoteUserId) {
      return;
    }

    message.supportsMultiRing = true;
    if (!broadcast) {
      message.destinationDeviceId = remoteDeviceId;
    }
    if (!call.sendSignaling) {
      return;
    }
    call.sendSignaling(message);
  }

  // Called by MessageReceiver
  // tslint:disable-next-line cyclomatic-complexity
  handleCallingMessage(
    remoteUserId: UserId,
    remoteDeviceId: DeviceId,
    message: CallingMessage
  ): void {
    const remoteSupportsMultiRing = message.supportsMultiRing || false;
    if (message.offer && message.offer.callId && message.offer.sdp) {
      const callId = message.offer.callId;
      const sdp = message.offer.sdp;
      const offerType = message.offer.type || OfferType.AudioCall;
      if (offerType === OfferType.NeedsPermission) {
        if (!!this.handleIgnoredCall) {
          this.handleIgnoredCall(
            remoteUserId,
            CallIgnoredReason.NeedsPermission
          );
        }
        return;
      }
      this.callManager.receivedOffer(
        remoteUserId,
        remoteDeviceId,
        callId,
        offerType,
        remoteSupportsMultiRing,
        sdp
      );
    }
    if (message.answer && message.answer.callId && message.answer.sdp) {
      const callId = message.answer.callId;
      const sdp = message.answer.sdp;
      this.callManager.receivedAnswer(
        remoteUserId,
        remoteDeviceId,
        callId,
        remoteSupportsMultiRing,
        sdp
      );
    }
    if (message.iceCandidates && message.iceCandidates.length > 0) {
      let callId = null;
      const candidateSdps: Array<string> = [];
      for (const candidate of message.iceCandidates) {
        // We assume they all have the same .callId
        callId = candidate.callId;
        if (!!candidate.sdp) {
          candidateSdps.push(candidate.sdp);
        }
      }

      this.callManager.receivedIceCandidates(
        remoteUserId,
        remoteDeviceId,
        callId,
        candidateSdps
      );
    }

    if (message.hangup && message.hangup.callId) {
      const callId = message.hangup.callId;
      const hangupType = message.hangup.type || HangupType.Normal;
      const hangupDeviceId = message.hangup.deviceId || null;
      this.callManager.receivedHangup(
        remoteUserId,
        remoteDeviceId,
        callId,
        hangupType,
        hangupDeviceId
      );
    }
    if (message.legacyHangup && message.legacyHangup.callId) {
      const callId = message.legacyHangup.callId;
      const hangupType = message.legacyHangup.type || HangupType.Normal;
      const hangupDeviceId = message.legacyHangup.deviceId || null;
      this.callManager.receivedHangup(
        remoteUserId,
        remoteDeviceId,
        callId,
        hangupType,
        hangupDeviceId
      );
    }
    if (message.busy && message.busy.callId) {
      const callId = message.busy.callId;
      this.callManager.receivedBusy(remoteUserId, remoteDeviceId, callId);
    }
  }
}

interface CallSettings {
  localDeviceId: DeviceId;
  iceServer: IceServer;
  hideIp: boolean;
}

interface IceServer {
  username?: string;
  password?: string;
  urls: Array<string>;
}

export class Call {
  // The calls' info and state.
  private readonly _callManager: CallManager;
  private readonly _remoteUserId: UserId;
  // We can have a null CallId while we're waiting for RingRTC to give us one.
  callId: CallId | null;
  private readonly _incoming: boolean;
  // We can have a null CallSettings while we're waiting for the UX to give us one.
  settings: CallSettings | null;
  private _state: CallState;
  private _outgoingVideoEnabled: boolean = false;
  endedReason?: string;

  // The callbacks that should be set by the UX code.
  sendSignaling?: (message: CallingMessage) => void;
  handleStateChanged?: () => void;
  handleRemoteVideoEnabled?: (enabled: boolean) => void;
  renderVideoFrame?: (
    width: number,
    height: number,
    buffer: ArrayBuffer
  ) => void;

  constructor(
    callManager: CallManager,
    remoteUserId: UserId,
    callId: CallId,
    incoming: boolean,
    settings: CallSettings | null,
    state: CallState
  ) {
    this._callManager = callManager;
    this._remoteUserId = remoteUserId;
    this.callId = callId;
    this._incoming = incoming;
    this.settings = settings;
    this._state = state;
  }

  get remoteUserId(): UserId {
    return this._remoteUserId;
  }

  get incoming(): boolean {
    return this._incoming;
  }

  get state(): CallState {
    return this._state;
  }

  set state(state: CallState) {
    this._state = state;
    if (!!this.handleStateChanged) {
      this.handleStateChanged();
    }
  }

  accept(): void {
    this._callManager.accept(this.callId);
  }

  hangup(): void {
    // This assumes we only have one active all.
    (async () => {
      // This is a silly way of causing a deadlock.
      // tslint:disable-next-line await-promise
      await 0;
      this._callManager.hangup();
    })();
  }

  set outgoingAudioEnabled(enabled: boolean) {
    // This assumes we only have one active all.
    (async () => {
      // This is a silly way of not causing a deadlock.
      // tslint:disable-next-line await-promise
      await 0;
      this._callManager.setOutgoingAudioEnabled(enabled);
    })();
  }

  get outgoingVideoEnabled(): boolean {
    return this._outgoingVideoEnabled;
  }

  set outgoingVideoEnabled(enabled: boolean) {
    this._outgoingVideoEnabled = enabled;
    if (this.state === CallState.Accepted) {
      // This assumes we only have one active all.
      this._callManager.sendVideoStatus(enabled);
    }
  }

  sendVideoFrame(width: number, height: number, rgbaBuffer: ArrayBuffer) {
    // This assumes we only have one active all.
    this._callManager.sendVideoFrame(width, height, rgbaBuffer);
  }
}

export type UserId = string;

export type DeviceId = number;

export type CallId = any;

export class CallingMessage {
  offer?: OfferMessage;
  answer?: AnswerMessage;
  iceCandidates?: Array<IceCandidateMessage>;
  legacyHangup?: HangupMessage;
  busy?: BusyMessage;
  hangup?: HangupMessage;
  supportsMultiRing?: boolean;
  destinationDeviceId?: DeviceId;
}

export class OfferMessage {
  callId?: CallId;
  type?: OfferType;
  sdp?: string;
}

export enum OfferType {
  AudioCall = 0,
  VideoCall = 1,
  NeedsPermission = 2,
}

export class AnswerMessage {
  callId?: CallId;
  sdp?: string;
}

export class IceCandidateMessage {
  callId?: CallId;
  mid?: string;
  midIndex?: number;
  sdp?: string;
}

export class BusyMessage {
  callId?: CallId;
}

export class HangupMessage {
  callId?: CallId;
  type?: HangupType;
  deviceId?: DeviceId;
}

export enum HangupType {
  Normal = 0,
  Accepted = 1,
  Declined = 2,
  Busy = 3,
}

export interface CallManager {
  call(remoteUserId: UserId, isVideoCall: boolean): void;
  proceed(
    callId: CallId,
    localDeviceId: DeviceId,
    iceServerUsername: string,
    iceServerPassword: string,
    iceServerUrls: Array<string>,
    hideIp: boolean,
    enableForking: boolean
  ): void;
  accept(callId: CallId): void;
  hangup(): void;
  setOutgoingAudioEnabled(enabled: boolean): void;
  sendVideoStatus(enabled: boolean): void;
  sendVideoFrame(width: number, height: number, buffer: ArrayBuffer): void;
  receivedOffer(
    remoteUserId: UserId,
    remoteDeviceId: DeviceId,
    callId: CallId,
    offerType: OfferType,
    remoteSupportsMultiRing: boolean,
    sdp: string
  ): void;
  receivedAnswer(
    remoteUserId: UserId,
    remoteDeviceId: DeviceId,
    callId: CallId,
    remoteSupportsMultiRing: boolean,
    sdp: string
  ): void;
  receivedIceCandidates(
    remoteUserId: UserId,
    remoteDeviceId: DeviceId,
    callId: CallId,
    candiateSdps: Array<string>
  ): void;
  receivedHangup(
    remoteUserId: UserId,
    remoteDeviceId: DeviceId,
    callId: CallId,
    hangupType: HangupType,
    hangupDeviceId: DeviceId | null
  ): void;
  receivedBusy(
    remoteUserId: UserId,
    remoteDeviceId: DeviceId,
    callId: CallId
  ): void;
  poll(callbacks: CallManagerCallbacks): void;
}

export interface CallManagerCallbacks {
  onStartOutgoingCall(remoteUserId: UserId, callId: CallId): void;
  onStartIncomingCall(remoteUserId: UserId, callId: CallId): void;
  onCallState(remoteUserId: UserId, state: CallState): void;
  onCallEnded(remoteUserId: UserId, endReason: string): void;
  onRemoteVideoEnabled(remoteUserId: UserId, enabled: boolean): void;
  renderVideoFrame(width: number, height: number, buffer: ArrayBuffer): void;
  onSendOffer(
    remoteUserId: UserId,
    remoteDeviceId: DeviceId,
    callId: CallId,
    broadcast: boolean,
    mediaType: number,
    sdp: string
  ): void;
  onSendAnswer(
    remoteUserId: UserId,
    remoteDeviceId: DeviceId,
    callId: CallId,
    broadcast: boolean,
    sdp: string
  ): void;
  onSendIceCandidates(
    remoteUserId: UserId,
    remoteDeviceId: DeviceId,
    callId: CallId,
    broadcast: boolean,
    candidates: Array<IceCandidateMessage>
  ): void;
  onSendLegacyHangup(
    remoteUserId: UserId,
    remoteDeviceId: DeviceId,
    callId: CallId,
    broadcast: boolean,
    HangupType: HangupType,
    hangupDeviceId: DeviceId | null
  ): void;
  onSendHangup(
    remoteUserId: UserId,
    remoteDeviceId: DeviceId,
    callId: CallId,
    broadcast: boolean,
    HangupType: HangupType,
    hangupDeviceId: DeviceId | null
  ): void;
  onSendBusy(
    remoteUserId: UserId,
    remoteDeviceId: DeviceId,
    callId: CallId,
    broadcast: boolean
  ): void;
  onLog(message: string): void;
}

export enum CallState {
  Prering = 'init',
  Ringing = 'ringing',
  Accepted = 'connected',
  Reconnecting = 'connecting',
  Ended = 'concluded',
}

export enum CallIgnoredReason {
  NeedsPermission = 1,
}