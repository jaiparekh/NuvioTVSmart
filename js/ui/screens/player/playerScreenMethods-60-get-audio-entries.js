/* eslint-disable no-unused-vars */
import * as internals from "./playerScreenContext.js";
import { replaceMkvBrowserCompatibility, closeMkvBrowserCompatibility } from "../../../core/player/mkvBrowserCompatibility.js";

export function createPlayerScreenMethods60() {
  const {
    PlayerController,
    Environment,
    AUDIO_AMPLIFICATION_MIN_DB,
    AUDIO_AMPLIFICATION_MAX_DB,
    getAudioTrackSupportState,
    formatAudioTrackDisplay,
    clamp
  } = internals;

  return {
    getAudioEntries() {
      // A converted HLS playlist exposes only the chosen output audio track.
      // Present the original MKV's embedded tracks instead, with source indexes.
      const mkvSession = this.mkvCompatibilitySession;
      if (mkvSession?.id && Array.isArray(mkvSession.audioTracks) && mkvSession.audioTracks.length) {
        return mkvSession.audioTracks.map((track, index) => {
          const display = formatAudioTrackDisplay({
            ...track, codec: track.codec || track.codec_name,
            language: track.language || track.lang,
            channels: track.channels
          }, index);
          return {
            id: `audio-mkv-${track.index}`,
            label: display.label,
            secondary: display.secondary,
            languageText: display.languageText,
            metadata: display.metadata,
            selected: track.index === mkvSession.audioStreamIndex,
            supported: true,
            mkvAudioStreamIndex: track.index,
            track
          };
        });
      }
      const cachedEntries = this.trackDialogCache?.audioEntries;
      if (cachedEntries) {
        return cachedEntries;
      }
      const avplayAudioTracks = typeof PlayerController.getAvPlayAudioTracks === "function" ? PlayerController.getAvPlayAudioTracks() : [];
      let entries = [];
      if (avplayAudioTracks.length) {
        const selectedAvPlayAudioTrack =
          typeof PlayerController.getSelectedAvPlayAudioTrackIndex === "function"
            ? PlayerController.getSelectedAvPlayAudioTrackIndex()
            : -1;
        entries = avplayAudioTracks.map((track, index) => {
          let mergedTrack = this.mergeAvPlayAudioTrackMetadata(track, index);
          if (Environment.isTizen() && this.manifestAudioTracks.length) {
            // AVPlay exposes manifest names/languages only from extra_info; when
            // they are absent, the parsed HLS/DASH rendition list is the same
            // metadata Android TV reads from the manifest.
            mergedTrack = this.mergeManifestAudioTrackMetadata(mergedTrack, index, avplayAudioTracks.length);
          }
          const support = this.isTizenDashAudioSwitchingUnsupported()
            ? { supported: false, unsupportedReason: "tizen-dash-audio" }
            : getAudioTrackSupportState(mergedTrack);
          const avplayTrackIndex = Number(track?.avplayTrackIndex);
          const normalizedTrackIndex = Number.isFinite(avplayTrackIndex) ? avplayTrackIndex : index;
          const display = formatAudioTrackDisplay(mergedTrack, index);
          return {
            id: `audio-avplay-${normalizedTrackIndex}`,
            label: display.label,
            secondary: display.secondary,
            languageText: display.languageText,
            metadata: display.metadata,
            selected:
              normalizedTrackIndex === selectedAvPlayAudioTrack ||
              (selectedAvPlayAudioTrack < 0 && normalizedTrackIndex === this.selectedAudioTrackIndex),
            supported: support.supported,
            canTryAudioConversion: Boolean(support.canTryAudioConversion),
            unsupportedReason: support.unsupportedReason,
            avplayAudioTrackIndex: normalizedTrackIndex,
            track: {
              ...mergedTrack,
              ...support
            }
          };
        });
      } else {
        const dashAudioTracks = typeof PlayerController.getDashAudioTracks === "function" ? PlayerController.getDashAudioTracks() : [];
        if (dashAudioTracks.length) {
          const selectedDashAudioTrack =
            typeof PlayerController.getSelectedDashAudioTrackIndex === "function" ? PlayerController.getSelectedDashAudioTrackIndex() : -1;
          entries = dashAudioTracks.map((track, index) => {
            const display = formatAudioTrackDisplay(track, index);
            const support = getAudioTrackSupportState(track);
            return {
              id: `audio-dash-${index}-${track?.id ?? ""}`,
              label: display.label,
              secondary: display.secondary,
              languageText: display.languageText,
              metadata: display.metadata,
              selected: index === selectedDashAudioTrack || (selectedDashAudioTrack < 0 && index === this.selectedAudioTrackIndex),
              supported: support.supported,
              canTryAudioConversion: Boolean(support.canTryAudioConversion),
              unsupportedReason: support.unsupportedReason,
              dashAudioTrackIndex: index,
              track: {
                ...track,
                ...support
              }
            };
          });
        } else {
          const hlsAudioTracks = typeof PlayerController.getHlsAudioTracks === "function" ? PlayerController.getHlsAudioTracks() : [];
          if (hlsAudioTracks.length) {
            const selectedHlsAudioTrack =
              typeof PlayerController.getSelectedHlsAudioTrackIndex === "function" ? PlayerController.getSelectedHlsAudioTrackIndex() : -1;
            entries = hlsAudioTracks.map((track, index) => {
              const mergedTrack = this.mergeHlsAudioTrackMetadata(track, index);
              const display = formatAudioTrackDisplay(mergedTrack, index);
              const support = getAudioTrackSupportState(mergedTrack);
              return {
                id: `audio-hls-${index}-${mergedTrack?.id ?? mergedTrack?.name ?? mergedTrack?.lang ?? ""}`,
                label: display.label,
                secondary: display.secondary,
                languageText: display.languageText,
                metadata: display.metadata,
                selected: index === selectedHlsAudioTrack || (selectedHlsAudioTrack < 0 && index === this.selectedAudioTrackIndex),
                supported: support.supported,
                canTryAudioConversion: Boolean(support.canTryAudioConversion),
                unsupportedReason: support.unsupportedReason,
                hlsAudioTrackIndex: index,
                track: {
                  ...mergedTrack,
                  ...support
                }
              };
            });
          } else {
            const conversion = Environment.isWebOS() ? PlayerController.webOsDtsAudioState : null;
            const projectedTracks = Boolean(conversion?.id && this.embeddedAudioTracks.length);
            // LG may expose only the converted track. Its native index no longer
            // represents the source list; retain all original language choices.
            const audioTracks = projectedTracks ? [] : this.getAudioTracks();
            if (audioTracks.length || this.embeddedAudioTracks.length) {
              entries = this.getMergedAudioTrackEntries(audioTracks);
              if (projectedTracks) {
                const selectedIndex = conversion.sourceTrackIndex ?? conversion.targetIndex;
                entries.forEach((entry) => {
                  entry.selected = entry.embeddedAudioTrackIndex === selectedIndex;
                });
              }
            } else if (this.manifestAudioTracks.length) {
              entries = this.manifestAudioTracks.map((track, index) => {
                const display = formatAudioTrackDisplay(track, index);
                const support = getAudioTrackSupportState(track);
                return {
                  id: `audio-manifest-${track.id}`,
                  label: display.label,
                  secondary: display.secondary,
                  languageText: display.languageText,
                  metadata: display.metadata,
                  selected: this.selectedManifestAudioTrackId === track.id,
                  supported: support.supported,
                  canTryAudioConversion: Boolean(support.canTryAudioConversion),
                  unsupportedReason: support.unsupportedReason,
                  manifestAudioTrackId: track.id,
                  track: {
                    ...track,
                    ...support
                  }
                };
              });
            } else {
              const implicitEntry = this.getImplicitAudioEntry();
              entries = implicitEntry ? [implicitEntry] : [];
            }
          }
        }
      }

      this.trackDialogCache.audioEntries = entries;
      return entries;
    },
    /** Switch the MKV source audio stream, retaining the current playback position. */
    async selectMkvCompatibilityAudioStream(audioStreamIndex) {
      const current = this.mkvCompatibilitySession;
      if (!current?.id || !current.audioTracks?.some((track) => track.index === audioStreamIndex)) return false;
      if (current.audioStreamIndex === audioStreamIndex) return true;
      const offset = Number(PlayerController.getCurrentTime?.() ?? PlayerController.video?.currentTime ?? 0);
      const next = await replaceMkvBrowserCompatibility(current.id, {
        audioStreamIndex,
        startSeconds: Math.max(0, Number.isFinite(offset) ? offset : 0)
      });
      if (!next) return false;
      if (this.mkvCompatibilitySession?.id !== current.id) {
        void closeMkvBrowserCompatibility(next.id);
        return false;
      }
      this.mkvCompatibilitySession = next;
      this.activePlaybackUrl = new URL(next.playlistUrl, globalThis.location.origin).href;
      this.invalidateTrackDialogCaches();
      this.renderAudioDialog();
      await this.startPlayerControllerPlayback(this.activePlaybackUrl, {
        ...this.buildPlaybackContext(this.getCurrentStreamCandidate()),
        forceEngine: "hls.js",
        requestHeaders: {},
        mediaSourceType: "application/vnd.apple.mpegurl"
      }, { sourceCandidate: this.getCurrentStreamCandidate() });
      return true;
    },
    getImplicitAudioEntry() {
      const currentStream = this.getCurrentStreamCandidate()?.raw || this.getCurrentStreamCandidate() || {};
      const hasPlaybackContext = Boolean(this.activePlaybackUrl || currentStream?.url || currentStream?.externalUrl || currentStream?.ytId);
      if (!hasPlaybackContext) {
        return null;
      }

      const track = {
        language:
          currentStream?.language ||
          currentStream?.lang ||
          currentStream?.track_lang ||
          currentStream?.extraInfo?.language ||
          currentStream?.extraInfo?.track_lang ||
          "",
        sampleMimeType: currentStream?.sampleMimeType || currentStream?.mimeType || currentStream?.sourceType || currentStream?.type || "",
        codec: currentStream?.codec || currentStream?.codecs || currentStream?.audioCodec || currentStream?.extraInfo?.audioCodec || "",
        codecs: currentStream?.codecs || currentStream?.codec || currentStream?.audioCodec || currentStream?.extraInfo?.codecs || "",
        audioCodec: currentStream?.audioCodec || currentStream?.extraInfo?.audioCodec || "",
        channelCount:
          currentStream?.channelCount ||
          currentStream?.audioChannels ||
          currentStream?.channels ||
          currentStream?.extraInfo?.audioChannels ||
          "",
        channels:
          currentStream?.channels ||
          currentStream?.audioChannels ||
          currentStream?.channelCount ||
          currentStream?.extraInfo?.audioChannels ||
          "",
        sampleRate: currentStream?.sampleRate || currentStream?.audioSampleRate || currentStream?.extraInfo?.audioSampleRate || 0
      };
      const display = formatAudioTrackDisplay(track, 0);
      const support = getAudioTrackSupportState(track);
      return {
        id: "audio-implicit-0",
        label: display.label,
        secondary: display.secondary,
        languageText: display.languageText,
        metadata: display.metadata,
        selected: true,
        supported: support.supported,
        canTryAudioConversion: Boolean(support.canTryAudioConversion),
        unsupportedReason: support.unsupportedReason,
        implicitAudioTrack: true,
        audioTrackIndex: 0,
        track: {
          ...track,
          ...support
        }
      };
    },
    ensureSupportedAudioTrackSelected() {
      if (
        this.audioFallbackApplying ||
        this.pendingWebOsAudioSelection ||
        (Environment.isWebOS() && !this.startupTrackPreferenceReady) ||
        (Environment.isWebOS() && this.startupAudioGateActive && this.isAudioPreferenceDiscoveryPending())
      ) {
        return false;
      }
      const entries = this.getAudioEntries();
      const supportedEntryIndex = entries.findIndex((entry) => entry?.supported !== false);
      if (supportedEntryIndex < 0) {
        return false;
      }
      const supportedEntry = entries[supportedEntryIndex];
      if (supportedEntry?.id && supportedEntry.id === this.failedAutomaticAudioFallbackEntryId) {
        return false;
      }
      const selectedEntry = entries.find((entry) => entry?.selected);
      const shouldFallback = selectedEntry
        ? selectedEntry.supported === false && !selectedEntry.canTryAudioConversion
        : entries[0]?.supported === false && !entries[0]?.canTryAudioConversion;
      if (!shouldFallback) {
        return false;
      }

      this.audioFallbackApplying = true;
      try {
        this.applyAudioTrack(supportedEntryIndex, { automaticFallback: true });
      } finally {
        this.audioFallbackApplying = false;
      }
      return true;
    },
    isAudioEntryPending(entry = {}) {
      const pending = this.pendingWebOsAudioSelection;
      if (!pending) {
        return false;
      }
      if (pending.selectionKind === "embedded") {
        return Number(entry?.embeddedAudioTrackIndex) === Number(pending.selectedTrackIndex);
      }
      return Number(entry?.audioTrackIndex) === Number(pending.targetTrackIndex);
    },
    adjustAudioAmplification(delta = 0) {
      const nextDb = clamp(
        Number(this.audioAmplificationDb || 0) + Number(delta || 0),
        AUDIO_AMPLIFICATION_MIN_DB,
        AUDIO_AMPLIFICATION_MAX_DB
      );
      this.audioAmplificationDb = nextDb;
      this.persistPlayerPresentationSettings();
      this.applyAudioAmplification();
      this.renderAudioDialog();
    },
    togglePersistAudioAmplification() {
      this.persistAudioAmplification = !this.persistAudioAmplification;
      this.persistPlayerPresentationSettings();
      this.renderAudioDialog();
    },
    openAudioDialog() {
      // Install once on this player instance. The existing audio dialog calls
      // applyAudioTrack(index); intercept only entries from a converted MKV.
      if (!this.mkvCompatibilityApplyAudioWrapped && typeof this.applyAudioTrack === "function") {
        const originalApplyAudioTrack = this.applyAudioTrack;
        this.applyAudioTrack = function(index, ...args) {
          const entry = this.getAudioEntries()?.[index];
          if (this.mkvCompatibilitySession?.id && Number.isSafeInteger(entry?.mkvAudioStreamIndex)) {
            void this.selectMkvCompatibilityAudioStream(entry.mkvAudioStreamIndex).catch(() => {});
            return true;
          }
          return originalApplyAudioTrack.call(this, index, ...args);
        };
        this.mkvCompatibilityApplyAudioWrapped = true;
      }
      this.cancelSeekPreview({ commit: false });
      this.syncTrackState();
      this.applyAudioAmplification();
      this.audioDialogVisible = true;
      this.subtitleDialogVisible = false;
      this.speedDialogVisible = false;
      this.sourcesPanelVisible = false;
      let entries = this.getAudioEntries();
      if (!entries.length) {
        this.ensureTrackDataWarmup();
        entries = this.getAudioEntries();
      }
      const selectedEntry = entries.findIndex((entry) => entry.selected);
      this.audioDialogIndex = Math.max(0, selectedEntry >= 0 ? selectedEntry : 0);
      this.setControlsVisible(true, { focus: false });
      this.renderSubtitleDialog();
      this.renderAudioDialog();
      this.renderSpeedDialog();
      this.renderSourcesPanel();
      this.updateModalBackdrop();
    },
    closeAudioDialog() {
      this.audioDialogVisible = false;
      this.renderAudioDialog();
      this.updateModalBackdrop();
      this.resetControlsAutoHide();
    }
  };
}
