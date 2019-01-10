///<reference path='Yospace.d.ts'/>
import {
  AdBreak, AdBreakEvent, AdConfig, AdEvent, AdQuartile, AdQuartileEvent, AudioQuality, AudioTrack, BufferLevel,
  BufferType, DownloadedAudioData, DownloadedVideoData, LinearAd, LogLevel, MediaType, MetadataParsedEvent,
  MetadataType, Player, PlayerAdvertisingAPI, PlayerAPI, PlayerBufferAPI, PlayerConfig, PlayerEvent, PlayerEventBase,
  PlayerEventCallback, PlayerExports, PlayerSubtitlesAPI, PlayerType, PlayerVRAPI, QueryParameters, SeekEvent,
  SegmentMap, Snapshot, SourceConfig, StreamType, Technology, Thumbnail, TimeChangedEvent, TimeRange, VideoQuality,
  ViewMode, ViewModeOptions, PlaybackEvent, MetadataEvent,
} from 'bitmovin-player';
import {
  BYSAdBreakEvent, BYSAdEvent, BYSAnalyticsFiredEvent, BYSListenerEvent, YospaceAdListenerAdapter,
} from './YospaceListenerAdapter';
import { BitmovinYospacePlayerPolicy, DefaultBitmovinYospacePlayerPolicy } from './BitmovinYospacePlayerPolicy';
import { ArrayUtils } from 'bitmovin-player-ui/dist/js/framework/arrayutils';
import bitmovinAdvertisingModule from 'bitmovin-player/modules/bitmovinplayer-advertising-bitmovin';
import {
  YospaceErrorCode, YospaceErrorEvent, YospaceEventBase, YospacePlayerError, YospacePlayerEvent,
  YospacePlayerEventCallback, YospacePolicyError, YospacePolicyErrorCode,
} from "./YospaceError";
import { VastHelper } from './VastHelper';

export enum YospaceAssetType {
  LINEAR,
  VOD,
  LINEAR_START_OVER,
}

export interface YospaceSourceConfig extends SourceConfig {
  assetType: YospaceAssetType;
}

export interface YospaceConfiguration {
  debug?: boolean;
}

interface StreamPart {
  start: number;
  end: number;
  adBreak?: YSAdBreak;
}

interface StreamPartMapping {
  magic: StreamPart;
  original: StreamPart;
}

// TODO: remove this when it's available in the Player
interface LocalLinearAd extends LinearAd {
  extensions: any[];
}

export class BitmovinYospacePlayer implements PlayerAPI {
  // Bitmovin Player
  private readonly player: PlayerAPI;
  private eventHandlers: { [eventType: string]: YospacePlayerEventCallback[]; } = {};

  // Yospace fields
  private yospaceConfig: YospaceConfiguration;
  private yospaceSourceConfig: YospaceSourceConfig;
  private manager: YSSessionManager;
  private yospaceListenerAdapter: YospaceAdListenerAdapter;
  private playerPolicy: BitmovinYospacePlayerPolicy;

  // magic content duration handling
  private contentDuration: number = 0;
  private contentMapping: StreamPartMapping[] = [];
  private adParts: StreamPart[] = [];
  // helper attribute to calculate current time during an ad in live streams
  private adStartedTimestamp: number;

  // save original seek target in case of seek will seek over an AdBreak to recover to this position
  private cachedSeekTarget: number;

  // Event handling
  private suppressedEventsController: EventSuppressController = new EventSuppressController();

  // Replay support
  private isPlaybackFinished = false;

  // save playback speed to restore after AdBreak
  private playbackSpeed: number = 1;

  // save vpaid status
  private isVPaidActive = false;

  constructor(containerElement: HTMLElement, config: PlayerConfig, yospaceConfig: YospaceConfiguration = {}) {
    this.yospaceConfig = yospaceConfig;

    // Clear advertising config
    if (config.advertising) {
      console.warn('Client side advertising config is not supported');
    }
    // add advertising again to load ads module
    config.advertising = {};

    if (config.ui === undefined || config.ui) {
      console.warn('Please setup the UI after initializing the yospace player');
      config.ui = false;
    }

    // initialize bitmovin player
    Player.addModule(bitmovinAdvertisingModule);
    this.player = new Player(containerElement, config);

    // TODO: combine in something like a reportPlayerState method called for multiple events
    const onPlay = () => {
      if (this.isVPaidActive) {
        return;
      }

      this.manager.reportPlayerEvent(YSPlayerEvents.START);
    };

    const onTimeChanged = (event: TimeChangedEvent) => {
      if (this.isVPaidActive) {
        return;
      }

      this.manager.reportPlayerEvent(YSPlayerEvents.POSITION, event.time);

      // fire magic time-changed event
      this.fireEvent<TimeChangedEvent>({
        timestamp: Date.now(),
        type: PlayerEvent.TimeChanged,
        time: this.getCurrentTime(),
      });
    };

    const onPause = (event: PlaybackEvent) => {
      if (this.isVPaidActive) {
        return;
      }

      this.manager.reportPlayerEvent(YSPlayerEvents.PAUSE);

      if (!this.suppressedEventsController.isSuppressed(PlayerEvent.Paused)) {
        this.fireEvent(event);
      } else {
        this.suppressedEventsController.remove(PlayerEvent.Paused);
      }
    };

    const onSourceLoaded = () => {
      if (this.yospaceSourceConfig.assetType === YospaceAssetType.VOD) {
        const session = this.manager.session;
        const timeline = session.timeline;
        // calculate duration magic
        timeline.getAllElements().forEach((element) => {
          const originalChunk: StreamPart = {
            start: element.offset,
            end: element.offset + element.duration,
          };

          switch (element.type) {
            case YSTimelineElement.ADVERT:
              originalChunk.adBreak = element.adBreak;

              this.adParts.push(originalChunk);
              break;
            case YSTimelineElement.VOD:

              const magicalContentChunk = {
                start: this.contentDuration,
                end: this.contentDuration + element.duration,
              };

              this.contentMapping.push({
                magic: magicalContentChunk,
                original: originalChunk,
              });

              this.contentDuration += element.duration;
              break;
          }
        });
      }

      this.fireEvent({
        timestamp: Date.now(),
        type: PlayerEvent.SourceLoaded,
      });
    };

    const onSeek = (event: SeekEvent) => {
      if (this.isVPaidActive) {
        return;
      }

      this.manager.reportPlayerEvent(YSPlayerEvents.SEEK_START, this.player.getCurrentTime());

      if (!this.suppressedEventsController.isSuppressed(PlayerEvent.Seek)) {
        this.fireEvent(event);
      } else {
        this.suppressedEventsController.remove(PlayerEvent.Seek);
      }
    };

    const onSeeked = (event: SeekEvent) => {
      if (this.isVPaidActive) {
        return;
      }

      this.manager.reportPlayerEvent(YSPlayerEvents.SEEK_END, this.player.getCurrentTime());

      if (!this.suppressedEventsController.isSuppressed(PlayerEvent.Seeked)) {
        this.fireEvent(event);
      } else {
        this.suppressedEventsController.remove(PlayerEvent.Seeked);
      }
    };

    const onMetaData = (event: MetadataEvent) => {
      if (this.isVPaidActive) {
        return;
      }

      const validTypes = ['ID3', 'EMSG'];
      const type = event.metadataType;

      if (!validTypes.includes(type)) {
        return;
      }

      let yospaceMetadataObject: { [key: string]: any; };
      if (type === 'ID3') {
        yospaceMetadataObject = this.parseId3Tags(event);
      } else {
        yospaceMetadataObject = this.mapEmsgToId3Tags(event);
      }

      this.manager.reportPlayerEvent(YSPlayerEvents.METADATA, yospaceMetadataObject);
    };

    const onAdFinished = (event: AdEvent) => {
      this.isVPaidActive = false;
      this.manager.session.suppressAnalytics(false);
    };

    this.player.on(PlayerEvent.Playing, onPlay);
    this.player.on(PlayerEvent.TimeChanged, onTimeChanged);
    this.player.on(PlayerEvent.Paused, onPause);

    this.player.on(PlayerEvent.Seek, onSeek);
    this.player.on(PlayerEvent.Seeked, onSeeked);

    this.player.on(PlayerEvent.SourceLoaded, onSourceLoaded);
    // To support ads in live streams we need to track metadata events
    this.player.on(PlayerEvent.Metadata, onMetaData);

    // subscribe to adFinished events. In Case of VPAID we rely on the real player event to track it.
    this.player.on(PlayerEvent.AdFinished, onAdFinished);
  }

  load(source: YospaceSourceConfig, forceTechnology?: string, disableSeeking?: boolean): Promise<void> {
    // for now we only support hls source
    if (!source.hls) {
      console.error('HLS source missing');
      return;
    }
    this.resetState();

    const url = source.hls;

    this.yospaceSourceConfig = source;

    return new Promise<void>(((resolve, reject) => {
      const onInitComplete = (state: YSSessionResult, result: YSSessionStatus) => {
        if (state === YSSessionResult.INITIALISED) {
          // clone source to not modify passed object
          let clonedSource = {
            ...source,
            hls: this.manager.masterPlaylist(), // use received url from yospace
          };

          if (this.manager.isYospaceStream()) {
            this.yospaceListenerAdapter = new YospaceAdListenerAdapter();
            this.bindYospaceEvent();
            this.manager.registerPlayer(this.yospaceListenerAdapter);

            // Initialize policy
            if (!this.playerPolicy) {
              this.playerPolicy = new DefaultBitmovinYospacePlayerPolicy(this);
            }

            this.player.load(clonedSource, forceTechnology, disableSeeking).then(resolve).catch(reject);
          } else {
            this.manager.shutdown();
            this.manager = null;

            this.handleYospaceError(new YospacePlayerError(YospaceErrorCode.INVALID_SOURCE));
            reject("Shutting down SDK on non-yospace stream");
          }
        } else {
          this.handleYospaceError(new YospacePlayerError(YospaceErrorCode.NO_ANALYTICS));
          reject();
        }
      };

      const properties = {
        ...YSSessionManager.DEFAULTS,
        DEBUGGING: Boolean(this.yospaceConfig.debug),
        USE_ID3: source.assetType !== YospaceAssetType.VOD, // Use time based tracking only for VOD
      };

      switch (source.assetType) {
        case YospaceAssetType.LINEAR:
          this.manager = YSSessionManager.createForLive(url, properties, onInitComplete);
          break;
        case YospaceAssetType.VOD:
          this.manager = YSSessionManager.createForVoD(url, properties, onInitComplete);
          break;
        case YospaceAssetType.LINEAR_START_OVER:
          this.manager = YSSessionManager.createForNonLinear(url, properties, onInitComplete);
          break;
        default:
          console.error('Undefined YospaceSourceConfig.assetType; Could not obtain session;');
      }
    }));
  }

  get ads(): PlayerAdvertisingAPI {
    return this.advertisingApi;
  }

  get buffer(): PlayerBufferAPI {
    return this.bufferApi;
  }

  setPolicy(policy: BitmovinYospacePlayerPolicy) {
    this.playerPolicy = policy;
  }

  off(eventType: PlayerEvent, callback: PlayerEventCallback): void {
    this.player.off(eventType, callback);
    ArrayUtils.remove(this.eventHandlers[eventType], callback);
  }

  on(eventType: YospacePlayerEvent, callback: PlayerEventCallback): void;
  on(eventType: PlayerEvent, callback: PlayerEventCallback): void;
  on(eventType: PlayerEvent | YospacePlayerEvent, callback: PlayerEventCallback): void {
    if (!EnumHelper.isYospaceEvent(eventType)) {
      // we need to suppress some events because they need to be modified first. so don't add it to the actual player
      const suppressedEventTypes = [
        PlayerEvent.SourceLoaded,
        PlayerEvent.TimeChanged,
        PlayerEvent.Paused,

        // Suppress all ad events
        PlayerEvent.AdBreakFinished,
        PlayerEvent.AdBreakStarted,
        PlayerEvent.AdClicked,
        PlayerEvent.AdError,
        PlayerEvent.AdFinished,
        PlayerEvent.AdLinearityChanged,
        PlayerEvent.AdManifestLoaded,
        PlayerEvent.AdQuartile,
        PlayerEvent.AdSkipped,
        PlayerEvent.AdStarted,
      ];

      const event = eventType as PlayerEvent;
      if (!suppressedEventTypes.includes(event)) {
        this.player.on(event, callback);
      }
    }

    if (!this.eventHandlers[eventType]) {
      this.eventHandlers[eventType] = [];
    }
    this.eventHandlers[eventType].push(callback);
  }

  play(issuer?: string): Promise<void> {
    if (this.isPlaybackFinished) {
      this.suppressedEventsController.add(PlayerEvent.Seek, PlayerEvent.Seeked);
      this.player.seek(0);
      this.isPlaybackFinished = false;
    }

    if (this.isAdActive() && this.player.isPaused()) {
      // track ad resumed
      this.getCurrentAd().adResumed();
    }
    return this.player.play(issuer);
  }

  pause(issuer?: string): void {
    if (this.playerPolicy.canPause()) {
      if (this.isAdActive() && this.player.isPlaying()) {
        // track ad paused
        this.getCurrentAd().adPaused();
      }
      this.player.pause();
    } else {
      this.handleYospacePolicyEvent(YospacePolicyErrorCode.PAUSE_NOT_ALLOWED);
    }
  }

  mute(issuer?: string): void {
    if (this.playerPolicy.canMute()) {
      this.player.mute();
    } else {
      this.handleYospacePolicyEvent(YospacePolicyErrorCode.MUTE_NOT_ALLOWED);
    }
  }

  /**
   * If policy.canSeekTo returns another position than the target, the player will restore to the original seek
   * position after the ads finished / skipped
   */
  seek(time: number, issuer?: string): boolean {
    // do not use this seek method for seeking within ads (skip) use player.seek(…) instead
    if (!this.playerPolicy.canSeek()) {
      this.handleYospacePolicyEvent(YospacePolicyErrorCode.SEEK_NOT_ALLOWED);
      return false;
    }

    const allowedSeekTarget = this.playerPolicy.canSeekTo(time);
    if (allowedSeekTarget !== time) {
      // cache original seek target
      this.cachedSeekTarget = time;
      this.handleYospacePolicyEvent(YospacePolicyErrorCode.SEEK_TO_NOT_ALLOWED);
    } else {
      this.cachedSeekTarget = null;
    }

    // magical content seeking
    const originalStreamPart = this.contentMapping.find((mapping: StreamPartMapping) => {
      return mapping.magic.start <= allowedSeekTarget && allowedSeekTarget <= mapping.magic.end;
    });

    const elapsedTimeInStreamPart = allowedSeekTarget - originalStreamPart.magic.start;
    const magicSeekTarget = originalStreamPart.original.start + elapsedTimeInStreamPart;

    return this.player.seek(magicSeekTarget, issuer);
  }

  getCurrentTime(): number {
    if (this.isAdActive()) {
      // return currentTime in AdBreak
      const currentAdPosition = this.player.getCurrentTime();
      return currentAdPosition - this.getAdStartTime(this.getCurrentAd());
    }

    return this.toMagicTime(this.player.getCurrentTime());
  }

  getDuration(): number {
    if (this.isAdActive()) {
      return this.getCurrentAd().duration;
    }

    if (this.isLive()) {
      return this.player.getDuration();
    }

    // return magic content duration
    return this.contentDuration;
  }

  /**
   * @deprecated Use {@link PlayerBufferAPI.getLevel} instead.
   */
  getVideoBufferLength(): number | null {
    return this.buffer.getLevel(BufferType.ForwardDuration, MediaType.Video).level;
  }

  /**
   * @deprecated Use {@link PlayerBufferAPI.getLevel} instead.
   */
  getAudioBufferLength(): number | null {
    return this.buffer.getLevel(BufferType.ForwardDuration, MediaType.Audio).level;
  }

  getBufferedRanges(): TimeRange[] {
    if (this.isLive()) {
      return this.player.getBufferedRanges();
    }

    const playerBufferedRanges = this.player.getBufferedRanges();
    const magicBufferedRanges: TimeRange[] = [];

    if (this.isAdActive()) {
      // Only return ranges within the active ad
      const currentAd = this.getCurrentAd();
      const adStart = this.getAdStartTime(currentAd);
      const adEnd = adStart + currentAd.duration;

      playerBufferedRanges.forEach((range) => {
        const magicStart = Math.max(adStart, range.start);
        const magicEnd = Math.min(adEnd, range.end);

        // Filter ranges that are not in current adParts by checking if end is greater as the start timestamp
        if (magicEnd > magicStart) {
          magicBufferedRanges.push({
            start: magicStart - adStart,
            end: magicEnd - adStart,
          });
        }
      });
    } else {
      playerBufferedRanges.forEach((range) => {
        const getAdAtTime = (time: number) => {
          return this.adParts.find((part) => part.start <= time && part.end >= time);
        };

        const adAtRangeStart = getAdAtTime(range.start);
        const adAtRangeEnd = getAdAtTime(range.end);

        let rangeStart: number = range.start;

        if (adAtRangeStart) {
          // If the start of the range is within an ad we have to modify the range start to the right content value.
          // Value should be adBreak finish timestamp and need to be mapped into magic time.
          // This value is then the magic start of the current range.
          rangeStart = getAdAtTime(range.start).end;
        }
        const magicRangeStart = this.toMagicTime(rangeStart);

        let rangeEnd: number = range.end;
        if (adAtRangeEnd) {
          // If the end of the range is within an ad we have to modify the range end to the right content value.
          // Value should be adBreak start timestamp and need to be mapped into magic time.
          // This value is then the magic start of the current range.
          rangeEnd = getAdAtTime(range.end).start;
        }

        let magicRangeEnd = this.toMagicTime(rangeEnd);

        const adBreaksBeforeRangeStart = this.getAdBreaksBefore(rangeStart);
        const adBreaksBeforeRangeEnd = this.getAdBreaksBefore(rangeEnd);

        // Check if there are adBreaks within the range
        if (adBreaksBeforeRangeStart.length !== adBreaksBeforeRangeEnd.length) {
          const diff = adBreaksBeforeRangeEnd.filter(x => !adBreaksBeforeRangeStart.includes(x));
          // Sum the getDuration of the delta adBreaks
          const sumOfAdBreakDurations = diff.reduce((sum, adBreak) => sum + adBreak.getDuration(), 0);
          // Subtract the sum from the modified range
          magicRangeEnd -= sumOfAdBreakDurations;
        }

        // It's possible that a range start and ends within an ad so the magic will map it to the same start and end
        // value. To filter them out we check if the end is greater than the start time.
        if (rangeEnd > rangeStart) {
          magicBufferedRanges.push({
            start: magicRangeStart,
            end: magicRangeEnd,
          });
        }
      });
    }

    return magicBufferedRanges;
  }

  setPlaybackSpeed(speed: number): void {
    if (!this.playerPolicy.canChangePlaybackSpeed()) {
      this.handleYospacePolicyEvent(YospacePolicyErrorCode.CHANGE_PLAYBACK_SPEED_NOT_ALLOWED);
      return;
    }

    this.playbackSpeed = speed;
    this.player.setPlaybackSpeed(this.playbackSpeed);
  }

  // Helper
  private isAdActive(): boolean {
    return Boolean(this.getCurrentAd());
  }

  private getCurrentAd(): YSAdvert | null {
    if (!this.manager) {
      return null;
    }
    return this.manager.session.currentAdvert;
  }

  private fireEvent<E extends PlayerEventBase | YospaceEventBase>(event: E): void {
    if (this.eventHandlers[event.type]) {
      this.eventHandlers[event.type].forEach((callback: YospacePlayerEventCallback) => callback(event));
    }
  }

  private bindYospaceEvent() {
    if (!this.yospaceListenerAdapter) {
      return;
    }

    this.yospaceListenerAdapter.addListener(BYSListenerEvent.AD_BREAK_START, this.onAdBreakStarted);
    this.yospaceListenerAdapter.addListener(BYSListenerEvent.ADVERT_START, this.onAdStarted);
    this.yospaceListenerAdapter.addListener(BYSListenerEvent.ADVERT_END, this.onAdFinished);
    this.yospaceListenerAdapter.addListener(BYSListenerEvent.AD_BREAK_END, this.onAdBreakFinished);
    this.yospaceListenerAdapter.addListener(BYSListenerEvent.ANALYTICS_FIRED, this.onAnalyticsFired);
  }

  private onAdBreakStarted = (event: BYSAdBreakEvent) => {
    this.player.setPlaybackSpeed(1);

    const adBreak = event.adBreak;
    const playerEvent = AdEventsFactory.createAdBreakEvent(this.player, adBreak, PlayerEvent.AdBreakStarted);
    this.fireEvent<AdBreakEvent>(playerEvent);
  };

  private onAdStarted = (event: BYSAdEvent) => {
    const currentAd = this.getCurrentAd();

    if (currentAd.hasInteractiveUnit()) {
      // Handle VPAID ad
      this.isVPaidActive = true;
      this.manager.session.suppressAnalytics(true);
      this.player.ads.schedule({
        tag: {
          url: VastHelper.buildVastXml(currentAd.advert),
          type: 'vast',
        },
        position: String(this.player.getCurrentTime()),
        replaceContentDuration: currentAd.duration,
      } as AdConfig).catch((reason: string) => {
        this.handleYospaceError(new YospacePlayerError(YospaceErrorCode.VPAID_ERROR, null, reason));
      });
    }

    const playerEvent = AdEventsFactory.createAdEvent(this.player, PlayerEvent.AdStarted, this.manager, this.getCurrentAd());
    this.fireEvent<AdEvent>(playerEvent);

    if (this.isLive()) {
      // save start position of an ad within a live stream to calculate the current time within the ad
      this.adStartedTimestamp = this.player.getCurrentTime();
    }
    // TODO: autoskip if available
  };

  private onAdFinished = (event: BYSAdEvent) => {
    const playerEvent = AdEventsFactory.createAdEvent(this.player, PlayerEvent.AdFinished, this.manager, this.getCurrentAd());
    this.fireEvent<AdEvent>(playerEvent);
    this.adStartedTimestamp = null;
  };

  private onAdBreakFinished = (event: BYSAdBreakEvent) => {
    const adBreak = event.adBreak;
    const playerEvent = AdEventsFactory.createAdBreakEvent(this.player, adBreak, PlayerEvent.AdBreakFinished);
    this.fireEvent<AdBreakEvent>(playerEvent);

    if (this.cachedSeekTarget) {
      this.seek(this.cachedSeekTarget, 'yospace-ad-skipping');
      this.cachedSeekTarget = null;
    }

    this.player.setPlaybackSpeed(this.playbackSpeed);
  };

  private onAnalyticsFired = (event: BYSAnalyticsFiredEvent) => {
    const isQuartileEvent = (eventName: string) => {
      const yospaceQuartileEventNames = [
        'firstQuartile',
        'midpoint',
        'thirdQuartile',
        // In our domain logic the 'complete' event is handed via the `AdFinished` event so we can ignore it here
      ];

      return yospaceQuartileEventNames.includes(eventName);
    };

    if (isQuartileEvent(event.call_id)) {
      this.handleQuartileEvent(event.call_id);
    }
  };

  private mapAdBreak(ysAdBreak: YSAdBreak): AdBreak {
    return {
      id: ysAdBreak.adBreakIdentifier, // can be null
      scheduleTime: this.toMagicTime(ysAdBreak.startPosition),
      ads: ysAdBreak.adverts.map(this.mapAd),
    };
  }

  private mapAd(ysAd: YSAdvert): LocalLinearAd {
    return {
      isLinear: Boolean(ysAd.advert.linear),
      duration: ysAd.duration,
      id: ysAd.advert.id,
      clickThroughUrl: ysAd.advert.linear.clickThrough,
      mediaFileUrl: ysAd.advert.linear.mediaFiles[0].src,
      skippableAfter: ysAd.advert.linear.skipOffset,
      uiConfig: {
        requestsUi: !ysAd.hasInteractiveUnit(),
      },
      extensions: VastHelper.getExtensions(ysAd.advert),
    };
  }

  private mapAdQuartile(quartileEvent: string): AdQuartile {
    switch (quartileEvent) {
      case 'firstQuartile':
        return AdQuartile.FIRST_QUARTILE;
      case 'midpoint':
        return AdQuartile.MIDPOINT;
      case 'thirdQuartile':
        return AdQuartile.THIRD_QUARTILE;
    }
  }

  private getAdBreaksBefore(position: number): YSAdBreak[] {
    return this.adParts
      .filter(part => part.start < position && position >= part.end)
      .map(element => element.adBreak);
  }

  private getAdStartTime(ad: YSAdvert): number {
    if (this.isLive()) {
      return this.adStartedTimestamp || 0;
    }

    const indexInAdBreak = ad.adBreak.adverts.indexOf(ad);
    const previousAdverts: YSAdvert[] = ad.adBreak.adverts.slice(0, indexInAdBreak);

    return ad.adBreak.startPosition + previousAdverts.reduce((sum, advert) => sum + advert.duration, 0);
  }

  private toMagicTime(playbackTime: number): number {
    const previousBreaksDuration = this.getAdBreaksBefore(playbackTime)
      .reduce((sum, adBreak) => sum + adBreak.getDuration(), 0);

    return playbackTime - previousBreaksDuration;
  }

  private magicBufferLevel(bufferLevel: BufferLevel): number {
    if (this.isAdActive()) {
      return Math.min(bufferLevel.level, this.getCurrentAd().duration);
    }

    let futureBreakDurations = 0;
    const currentPlayerTime = this.player.getCurrentTime();
    const bufferedRange = currentPlayerTime + bufferLevel.level;

    this.adParts.map((part: StreamPart) => {
      if (part.start > currentPlayerTime && part.end < bufferedRange) {
        futureBreakDurations += part.end - part.start;
      } else if (part.start > currentPlayerTime && part.start < bufferedRange && part.end > bufferedRange) {
        futureBreakDurations += bufferedRange - part.start;
      }
    });

    return Math.max(bufferLevel.level - futureBreakDurations, 0);
  }

  private resetState(): void {
    // reset all local attributes
    if (this.manager) {
      this.manager.shutdown();
      this.manager = null;
    }

    this.contentDuration = 0;
    this.contentMapping = [];
    this.adParts = [];
    this.adStartedTimestamp = null;
    this.cachedSeekTarget = null;
  }

  private handleQuartileEvent(adQuartileEventName: string): void {
    const playerEvent: AdQuartileEvent = {
      timestamp: Date.now(),
      type: PlayerEvent.AdQuartile,
      quartile: this.mapAdQuartile(adQuartileEventName),
    };

    this.fireEvent(playerEvent);
  }

  private handleYospaceError(error: YospacePlayerError) {
    this.handleYospaceEvent<YospaceErrorEvent>({
      timestamp: Date.now(),
      type: YospacePlayerEvent.YospaceError,
      code: error.code,
      name: error.name,
    });
  }

  private handleYospacePolicyEvent(code: YospacePolicyErrorCode): void {
    this.handleYospaceEvent<YospacePolicyError>({
      timestamp: Date.now(),
      type: YospacePlayerEvent.PolicyError,
      code: code,
      name: YospacePolicyErrorCode[code],
    });
  }

  private handleYospaceEvent<E extends YospaceEventBase>(event: E): void {
    this.fireEvent(event);
  }

  private parseId3Tags(event: MetadataEvent): Object {
    const charsToStr = (arr: [number]) => {
      return arr.filter(char => char > 31 && char < 127).map(char => String.fromCharCode(char)).join('');
    };

    const metadata = event.metadata as any;
    const yospaceMetadataObject: any = {
      startTime: event.start ? event.start : this.player.getCurrentTime(),
    };

    metadata.frames.forEach((frame: any) => {
      yospaceMetadataObject[frame.key] = charsToStr(frame.data);
    });

    return yospaceMetadataObject;
  }

  private mapEmsgToId3Tags(event: MetadataEvent): Object {
    const metadata = event.metadata as any;
    const yospaceMetadataObject: any = {
      startTime: metadata.presentationTime ? metadata.presentationTime : this.player.getCurrentTime(),
    };

    const messageData: string = metadata.messageData;
    messageData.split(',').forEach((metadata: string) => {
      let tags = metadata.split('=');
      yospaceMetadataObject[tags[0]] = tags[1];
    });

    return yospaceMetadataObject;
  }

  // Custom advertising module with overwritten methods
  private advertisingApi: PlayerAdvertisingAPI = {
    discardAdBreak: (adBreakId: string) => {
      console.warn('CSAI is not supported for yospace stream');
      return;
    },

    getActiveAdBreak: () => {
      if (!this.isAdActive()) {
        return undefined;
      }

      return this.mapAdBreak(this.getCurrentAd().adBreak);
    },

    getActiveAd: () => {
      if (!this.isAdActive()) {
        return undefined;
      }

      return this.mapAd(this.getCurrentAd());
    },

    isLinearAdActive: () => {
      return this.isAdActive();
    },

    list: () => {
      if (!this.manager) {
        return [];
      }

      return this.manager.session.timeline.getAllElements()
        .filter((element: YSTimelineElement) => element.type === YSTimelineElement.ADVERT)
        .map((element: YSTimelineElement) => this.mapAdBreak(element.adBreak));
    },

    schedule: (adConfig: AdConfig) => {
      return Promise.reject('CSAI is not supported for yospace stream');
    },

    skip: () => {
      if (this.isAdActive()) {
        if (this.playerPolicy.canSkip() === 0) {
          const ad = this.getCurrentAd();
          const seekTarget = this.getAdStartTime(ad) + ad.duration;

          if (seekTarget >= this.player.getDuration()) {
            this.isPlaybackFinished = true;
            this.suppressedEventsController.add(PlayerEvent.Paused, PlayerEvent.Seek, PlayerEvent.Seeked);
            this.player.pause();
            this.player.seek(ad.adBreak.startPosition - 1); // -1 to be sure to don't have a frame of the ad visible
            this.fireEvent({
              timestamp: Date.now(),
              type: PlayerEvent.PlaybackFinished
            });
          } else {
            this.player.seek(seekTarget, 'ad-skip');
          }

          this.fireEvent({
            timestamp: Date.now(),
            type: PlayerEvent.AdSkipped,
            ad: this.mapAd(ad),
          } as AdEvent);
        } else {
          this.handleYospacePolicyEvent(YospacePolicyErrorCode.SKIP_NOT_ALLOWED);
        }
      }
    },

    getModuleInfo: () => {
      return this.player.ads.getModuleInfo();
    },
  };

  private bufferApi: PlayerBufferAPI = {
    setTargetLevel: (type: BufferType, value: number, media: MediaType) => {
      this.player.buffer.setTargetLevel(type, value, media);
    },

    getLevel: (type: BufferType, media: MediaType) => {
      const bufferLevel = this.player.buffer.getLevel(type, media);
      bufferLevel.level = this.magicBufferLevel(bufferLevel);
      return bufferLevel;
    },
  };

  unload(): Promise<void> {
    this.resetState();

    return this.player.unload();
  }

  // Default PlayerAPI implementation
  get version(): string {
    return this.player.version;
  }

  get vr(): PlayerVRAPI {
    return this.player.vr;
  }

  get subtitles(): PlayerSubtitlesAPI {
    return this.player.subtitles;
  }

  /**
   * @deprecated
   */
  get exports(): PlayerExports {
    return this.player.exports;
  }

  addMetadata(metadataType: MetadataType.CAST, metadata: any): boolean {
    return this.player.addMetadata(metadataType, metadata);
  }

  castStop(): void {
    this.player.castStop();
  }

  castVideo(): void {
    this.player.castVideo();
  }

  clearQueryParameters(): void {
    this.player.clearQueryParameters();
  }

  destroy(): Promise<void> {
    return this.player.destroy();
  }

  getAudio(): AudioTrack {
    return this.player.getAudio();
  }

  getAudioQuality(): AudioQuality {
    return this.player.getAudioQuality();
  }

  getAvailableAudio(): AudioTrack[] {
    return this.player.getAvailableAudio();
  }

  getAvailableAudioQualities(): AudioQuality[] {
    return this.player.getAvailableAudioQualities();
  }

  getAvailableSegments(): SegmentMap {
    return this.player.getAvailableSegments();
  }

  getAvailableVideoQualities(): VideoQuality[] {
    return this.player.getAvailableVideoQualities();
  }

  getConfig(mergedConfig?: boolean): PlayerConfig {
    return this.player.getConfig(mergedConfig);
  }

  getContainer(): HTMLElement {
    return this.player.getContainer();
  }

  getDownloadedAudioData(): DownloadedAudioData {
    return this.player.getDownloadedAudioData();
  }

  getDownloadedVideoData(): DownloadedVideoData {
    return this.player.getDownloadedVideoData();
  }

  getDroppedVideoFrames(): number {
    return this.player.getDroppedVideoFrames();
  }

  getManifest(): string {
    return this.player.getManifest();
  }

  getMaxTimeShift(): number {
    return this.player.getMaxTimeShift();
  }

  getPlaybackAudioData(): AudioQuality {
    return this.player.getPlaybackAudioData();
  }

  getPlaybackSpeed(): number {
    return this.player.getPlaybackSpeed();
  }

  getPlaybackVideoData(): VideoQuality {
    return this.player.getPlaybackVideoData();
  }

  getPlayerType(): PlayerType {
    return this.player.getPlayerType();
  }

  getSeekableRange(): TimeRange {
    return this.player.getSeekableRange();
  }

  getSnapshot(type?: string, quality?: number): Snapshot {
    return this.player.getSnapshot(type, quality);
  }

  getSource(): SourceConfig | null {
    return this.player.getSource();
  }

  getStreamType(): StreamType {
    return this.player.getStreamType();
  }

  getSupportedDRM(): Promise<string[]> {
    return this.player.getSupportedDRM();
  }

  getSupportedTech(): Technology[] {
    return this.player.getSupportedTech();
  }

  getThumbnail(time: number): Thumbnail {
    return this.player.getThumbnail(time);
  }

  getTimeShift(): number {
    return this.player.getTimeShift();
  }

  getTotalStalledTime(): number {
    return this.player.getTotalStalledTime();
  }

  getVideoElement(): HTMLVideoElement | HTMLObjectElement {
    return this.player.getVideoElement();
  }

  getVideoQuality(): VideoQuality {
    return this.player.getVideoQuality();
  }

  getViewMode(): ViewMode {
    return this.player.getViewMode();
  }

  getVolume(): number {
    return this.player.getVolume();
  }

  hasEnded(): boolean {
    return this.player.hasEnded();
  }

  isAirplayActive(): boolean {
    return this.player.isAirplayActive();
  }

  isAirplayAvailable(): boolean {
    return this.player.isAirplayAvailable();
  }

  isCastAvailable(): boolean {
    return this.player.isCastAvailable();
  }

  isCasting(): boolean {
    return this.player.isCasting();
  }

  isDRMSupported(drmSystem: string): Promise<string> {
    return this.player.isDRMSupported(drmSystem);
  }

  isLive(): boolean {
    return this.player.isLive();
  }

  isMuted(): boolean {
    return this.player.isMuted();
  }

  isPaused(): boolean {
    return this.player.isPaused();
  }

  isPlaying(): boolean {
    return this.player.isPlaying();
  }

  isStalled(): boolean {
    return this.player.isStalled();
  }

  isViewModeAvailable(viewMode: ViewMode): boolean {
    return this.player.isViewModeAvailable(viewMode);
  }

  preload(): void {
    this.player.preload();
  }

  setAudio(trackID: string): void {
    this.player.setAudio(trackID);
  }

  setAudioQuality(audioQualityID: string): void {
    this.player.setAudioQuality(audioQualityID);
  }

  setAuthentication(customData: any): void {
    this.player.setAuthentication(customData);
  }

  setLogLevel(level: LogLevel): void {
    this.player.setLogLevel(level);
  }

  setPosterImage(url: string, keepPersistent: boolean): void {
    this.player.setPosterImage(url, keepPersistent);
  }

  setQueryParameters(queryParameters: QueryParameters): void {
    this.player.setQueryParameters(queryParameters);
  }

  setVideoElement(videoElement: HTMLElement): void {
    this.player.setVideoElement(videoElement);
  }

  setVideoQuality(videoQualityID: string): void {
    this.player.setVideoQuality(videoQualityID);
  }

  setViewMode(viewMode: ViewMode, options?: ViewModeOptions): void {
    this.player.setViewMode(viewMode, options);
  }

  setVolume(volume: number, issuer?: string): void {
    this.player.setVolume(volume);
  }

  showAirplayTargetPicker(): void {
    this.player.showAirplayTargetPicker();
  }

  timeShift(offset: number, issuer?: string): void {
    this.player.timeShift(offset, issuer);
  }

  unmute(issuer?: string): void {
    this.player.unmute(issuer);
  }
}

class AdEventsFactory {
  static createAdBreakEvent(player: PlayerAPI, adBreak: YSAdBreak, type: PlayerEvent): AdBreakEvent {
    return {
      timestamp: Date.now(),
      type: type,
      adBreak: {
        id: adBreak.adBreakIdentifier, // can be null
        scheduleTime: adBreak.startPosition,
      },
    };
  }

  static createAdEvent(player: PlayerAPI, type: PlayerEvent, manager: YSSessionManager, ad: YSAdvert): AdEvent {
    return {
      timestamp: Date.now(),
      type: type,
      ad: {
        id: ad.advert.id,
        isLinear: true,
        duration: ad.duration,
        skippableAfter: player.isLive() ? -1 : ad.advert.linear.skipOffset,
        clickThroughUrl: manager.session.getLinearClickthrough(),
        clickThroughUrlOpened: () => {
          manager.reportPlayerEvent(YSPlayerEvents.CLICK);
        },
        uiConfig: {
          requestsUi: !ad.hasInteractiveUnit(),
        },
        extensions: VastHelper.getExtensions(ad.advert),
      } as LocalLinearAd,
    };
  }
}

class EventSuppressController {
  private suppressedEvents: PlayerEvent[] = [];

  add(...items: PlayerEvent[]) {
    for (let item of items) {
      if (!this.isSuppressed(item)) {
        this.suppressedEvents.push(item);
      }
    }
  }

  remove(...items: PlayerEvent[]) {
    for (let item of items) {
      ArrayUtils.remove(this.suppressedEvents, item);
    }
  }

  isSuppressed(eventType: PlayerEvent): boolean {
    return this.suppressedEvents.includes(eventType);
  }
}

class EnumHelper {
  static isYospaceEvent(eventType: PlayerEvent | YospacePlayerEvent) {
    return Object.keys(YospacePlayerEvent).map((key: string) => {
      return YospacePlayerEvent[key as any];
    }).includes(eventType);
  }
}
