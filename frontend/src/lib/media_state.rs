// 媒体生命周期状态机(逐语义对齐 lib/media-state.ts):
// preview / playback / download 三通道,idle→queued→loading→ready/buffering
// →retrying/failed/unsupported,rank 决定并发态展示优先级。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MediaLifecycleState {
    Idle,
    Queued,
    Loading,
    Ready,
    Buffering,
    Retrying,
    Failed,
    Unsupported,
}

impl MediaLifecycleState {
    pub fn as_str(self) -> &'static str {
        match self {
            MediaLifecycleState::Idle => "idle",
            MediaLifecycleState::Queued => "queued",
            MediaLifecycleState::Loading => "loading",
            MediaLifecycleState::Ready => "ready",
            MediaLifecycleState::Buffering => "buffering",
            MediaLifecycleState::Retrying => "retrying",
            MediaLifecycleState::Failed => "failed",
            MediaLifecycleState::Unsupported => "unsupported",
        }
    }

    fn rank(self) -> u8 {
        match self {
            MediaLifecycleState::Idle => 0,
            MediaLifecycleState::Ready => 1,
            MediaLifecycleState::Queued => 2,
            MediaLifecycleState::Loading | MediaLifecycleState::Buffering => 3,
            MediaLifecycleState::Retrying
            | MediaLifecycleState::Failed
            | MediaLifecycleState::Unsupported => 4,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MediaScope {
    Preview,
    Playback,
    Download,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MediaLifecycleActionType {
    Queued,
    Load,
    Ready,
    Buffer,
    Fail,
    Unsupported,
    Retry,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MediaLifecycleAction {
    Scoped {
        scope: MediaScope,
        kind: MediaLifecycleActionType,
    },
    Reset,
}

/// 三通道状态快照(对齐 MediaLifecycleMap)。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MediaLifecycleMap {
    pub preview: MediaLifecycleState,
    pub playback: MediaLifecycleState,
    pub download: MediaLifecycleState,
}

impl Default for MediaLifecycleMap {
    fn default() -> Self {
        Self::new()
    }
}

impl MediaLifecycleMap {
    pub fn new() -> Self {
        Self {
            preview: MediaLifecycleState::Idle,
            playback: MediaLifecycleState::Idle,
            download: MediaLifecycleState::Idle,
        }
    }

    pub fn scope(&self, scope: MediaScope) -> MediaLifecycleState {
        match scope {
            MediaScope::Preview => self.preview,
            MediaScope::Playback => self.playback,
            MediaScope::Download => self.download,
        }
    }

    fn with_scope(mut self, scope: MediaScope, state: MediaLifecycleState) -> Self {
        match scope {
            MediaScope::Preview => self.preview = state,
            MediaScope::Playback => self.playback = state,
            MediaScope::Download => self.download = state,
        }
        self
    }
}

pub fn create_media_lifecycle_map() -> MediaLifecycleMap {
    MediaLifecycleMap::new()
}

/// 归约(对齐 reduceMediaLifecycle:queued/ready 不覆盖更高语义态,
/// buffer 仅从 loading/ready 进入)。
pub fn reduce_media_lifecycle(
    state: &MediaLifecycleMap,
    action: MediaLifecycleAction,
) -> MediaLifecycleMap {
    if let MediaLifecycleAction::Reset = action {
        return create_media_lifecycle_map();
    }

    let MediaLifecycleAction::Scoped { scope, kind } = action else {
        return state.clone();
    };
    let current = state.scope(scope);
    let next = match kind {
        MediaLifecycleActionType::Queued => {
            if current == MediaLifecycleState::Ready {
                current
            } else {
                MediaLifecycleState::Queued
            }
        }
        MediaLifecycleActionType::Load | MediaLifecycleActionType::Retry => {
            MediaLifecycleState::Loading
        }
        MediaLifecycleActionType::Ready => {
            if current == MediaLifecycleState::Unsupported {
                current
            } else {
                MediaLifecycleState::Ready
            }
        }
        MediaLifecycleActionType::Buffer => {
            if current == MediaLifecycleState::Loading
                || current == MediaLifecycleState::Ready
            {
                MediaLifecycleState::Buffering
            } else {
                current
            }
        }
        MediaLifecycleActionType::Fail => MediaLifecycleState::Failed,
        MediaLifecycleActionType::Unsupported => MediaLifecycleState::Unsupported,
    };

    state.clone().with_scope(scope, next)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ActiveMediaState {
    pub scope: MediaScope,
    pub state: MediaLifecycleState,
}

/// 选出 rank 最高的通道(并列取首个,对齐 selectActiveMediaState 的 reduce)。
pub fn select_active_media_state(
    entries: &[(MediaScope, MediaLifecycleState)],
) -> Option<ActiveMediaState> {
    let mut active: Option<(usize, (MediaScope, MediaLifecycleState))> = None;
    for (index, entry) in entries.iter().enumerate() {
        let take = match active {
            None => true,
            Some((_, (_, active_state))) => entry.1.rank() > active_state.rank(),
        };
        if take {
            active = Some((index, *entry));
        }
    }
    active.map(|(_, (scope, state))| ActiveMediaState { scope, state })
}

pub fn is_failure_media_state(state: MediaLifecycleState) -> bool {
    state == MediaLifecycleState::Retrying
        || state == MediaLifecycleState::Failed
        || state == MediaLifecycleState::Unsupported
}
