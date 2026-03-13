/**
 * GlobalPodcastPlayer - 全局播客迷你播放器
 * 通过BroadcastChannel在页面间同步播放状态
 * 使用localStorage持久化播放进度
 */

class GlobalPodcastPlayer {
    constructor() {
        this.channel = null;
        this.audio = null;
        this.currentEpisode = null;
        this.playlist = [];
        this.currentIndex = -1;
        this.isPlaying = false;
        this.isInitialized = false;
        
        // 初始化
        this.init();
    }

    init() {
        if (this.isInitialized) return;

        // 创建或获取BroadcastChannel（兼容两个频道名）
        try {
            this.channel = new BroadcastChannel('podcast_player');
            this.channel.onmessage = (e) => this.handleChannelMessage(e);
        } catch (e) {
            console.warn('[GlobalPlayer] BroadcastChannel不可用:', e);
        }

        // 不再自动恢复播放状态，所有播放都需要用户手动操作
        // 移除页面加载时的自动恢复
        // 移除页面可见性变化时的自动恢复

        this.isInitialized = true;
        console.log('[GlobalPlayer] 已初始化');
    }

    // 处理跨页面消息
    handleChannelMessage(event) {
        const { type, episode, playlist, index, action, currentTime, isPlaying } = event.data;

        switch (type) {
            case 'play':
                this.playEpisode(episode, playlist, index, false);
                break;
            case 'toggle':
                this.togglePlay();
                break;
            case 'pause':
                this.pause();
                break;
            case 'seek':
                if (this.audio) {
                    this.audio.currentTime = currentTime;
                }
                break;
            case 'sync':
                // 同步状态
                this.syncState(currentTime, isPlaying);
                break;
        }
    }

    // 播放剧集
    playEpisode(episode, playlist = null, index = -1, broadcast = true) {
        this.currentEpisode = episode;
        if (playlist) {
            this.playlist = playlist;
            this.currentIndex = index;
        }

        // 创建或获取音频元素
        if (!this.audio) {
            this.audio = new Audio();
            this.audio.preload = 'auto'; // 强制预加载完整音频
            this.setupAudioListeners();
        } else {
            // 已有音频对象，更新预加载策略
            this.audio.preload = 'auto';
        }

        this.audio.src = episode.audio_url;
        
        // 恢复播放进度
        const savedTime = localStorage.getItem(`podcast_time_${episode.episode_id}`);
        if (savedTime) {
            this.audio.currentTime = parseFloat(savedTime);
        }

        this.updateUI();
        this.audio.play().catch(e => console.warn('[GlobalPlayer] 播放失败:', e));
        this.isPlaying = true;

        // 广播给其他页面
        if (broadcast) {
            this.broadcast('play', { episode, playlist, index });
        }

        this.saveState();
    }

    // 设置音频事件监听
    setupAudioListeners() {
        // 播放进度更新
        this.audio.addEventListener('timeupdate', () => {
            this.updateProgress();
            // 保存播放进度
            if (this.currentEpisode) {
                localStorage.setItem(`podcast_time_${this.currentEpisode.episode_id}`, this.audio.currentTime);
            }
        });

        // 音频播放完成
        this.audio.addEventListener('ended', () => {
            this.playNext();
        });

        // 音频数据加载完成
        this.audio.addEventListener('loadeddata', () => {
            console.log('[GlobalPlayer] 音频数据已加载');
        });

        // 可以流畅播放（缓冲完成）
        this.audio.addEventListener('canplaythrough', () => {
            console.log('[GlobalPlayer] 音频已缓冲完成，可以流畅播放');
        });

        // 等待更多数据
        this.audio.addEventListener('waiting', () => {
            console.log('[GlobalPlayer] 等待更多数据...');
        });

        // 播放停滞
        this.audio.addEventListener('stalled', () => {
            console.warn('[GlobalPlayer] 播放停滞，可能是网络问题');
        });

        // 播放开始
        this.audio.addEventListener('play', () => {
            this.isPlaying = true;
            this.updateUI();
            this.saveState();
        });

        // 暂停
        this.audio.addEventListener('pause', () => {
            this.isPlaying = false;
            this.updateUI();
            this.saveState();
        });

        // 加载错误
        this.audio.addEventListener('error', (e) => {
            console.error('[GlobalPlayer] 音频加载错误:', e);
            console.error('[GlobalPlayer] audio.error:', this.audio.error);
            console.error('[GlobalPlayer] audio.src:', this.audio.src);
            console.error('[GlobalPlayer] audio.readyState:', this.audio.readyState);
        });
    }

    // 切换播放/暂停
    togglePlay() {
        if (!this.currentEpisode) return;
        
        if (this.isPlaying) {
            this.pause();
        } else {
            this.audio.play().catch(e => console.warn('[GlobalPlayer] 播放失败:', e));
        }
        
        this.broadcast('sync', { currentTime: this.audio.currentTime, isPlaying: this.isPlaying });
    }

    // 暂停
    pause() {
        if (this.audio) {
            this.audio.pause();
        }
    }

    // 播放下一首
    playNext() {
        if (this.playlist.length === 0) return;
        const nextIndex = (this.currentIndex + 1) % this.playlist.length;
        this.playEpisode(this.playlist[nextIndex], this.playlist, nextIndex);
    }

    // 播放上一首
    playPrevious() {
        if (this.playlist.length === 0) return;
        const prevIndex = (this.currentIndex - 1 + this.playlist.length) % this.playlist.length;
        this.playEpisode(this.playlist[prevIndex], this.playlist, prevIndex);
    }

    // 跳转播放
    seek(time) {
        if (this.audio) {
            this.audio.currentTime = time;
            this.broadcast('seek', { currentTime: time });
        }
    }

    // 同步状态
    syncState(currentTime, isPlaying) {
        if (this.audio && currentTime !== undefined) {
            this.audio.currentTime = currentTime;
        }
        if (isPlaying !== undefined) {
            this.isPlaying = isPlaying;
            this.updateUI();
        }
    }

    // 广播消息
    broadcast(type, data) {
        if (this.channel) {
            this.channel.postMessage({ type, ...data });
        }
    }

    // 更新UI
    updateUI() {
        const playerBar = document.getElementById('globalPlayerBar');
        if (!playerBar || !this.currentEpisode) return;

        // 显示播放器
        playerBar.classList.add('show');

        // 更新标题
        const titleEl = playerBar.querySelector('.global-player-title');
        if (titleEl) {
            titleEl.textContent = this.currentEpisode.title;
        }

        // 更新封面
        const coverEl = playerBar.querySelector('.global-player-cover');
        if (coverEl) {
            if (this.currentEpisode.cover_image) {
                coverEl.innerHTML = `<img src="${this.currentEpisode.cover_image}">`;
            } else {
                coverEl.innerHTML = '&#127911;';
            }
        }

        // 更新播放按钮
        const playBtn = playerBar.querySelector('.global-player-play-btn');
        if (playBtn) {
            playBtn.innerHTML = this.isPlaying ? '&#10074;&#10074;' : '&#9654;';
        }

        // 更新进度条
        this.updateProgress();
    }

    // 更新进度条
    updateProgress() {
        const playerBar = document.getElementById('globalPlayerBar');
        if (!playerBar || !this.audio || !this.audio.duration) return;

        const progress = (this.audio.currentTime / this.audio.duration) * 100;
        const progressEl = playerBar.querySelector('.global-player-progress-current');
        if (progressEl) {
            progressEl.style.width = progress + '%';
        }
    }

        // 保存状态到localStorage（兼容两个key）
        saveState() {
            const state = {
                episode: this.currentEpisode,
                playlist: this.playlist,
                currentIndex: this.currentIndex,
                isPlaying: this.isPlaying,
                currentTime: this.audio ? this.audio.currentTime : 0
            };
            // 使用统一的key，与audio-player.html兼容
            localStorage.setItem('podcast_playback', JSON.stringify(state));
        }

        // 从localStorage恢复状态（兼容两个key）
        restoreState() {
            // 先尝试新key，再尝试旧key
            let savedState = localStorage.getItem('podcast_playback');
            if (!savedState) {
                savedState = localStorage.getItem('podcast_global_state');
            }
            if (!savedState) return;

        try {
            const state = JSON.parse(savedState);
            if (state.episode) {
                this.currentEpisode = state.episode;
                this.playlist = state.playlist || [];
                this.currentIndex = state.currentIndex || 0;

                // 创建音频元素
                if (!this.audio) {
                    this.audio = new Audio();
                    this.audio.preload = 'auto'; // 强制预加载完整音频
                    this.setupAudioListeners();
                }

                this.audio.src = state.episode.audio_url;
                if (state.currentTime) {
                    this.audio.currentTime = state.currentTime;
                }

                this.updateUI();

                // 只恢复播放进度，不自动播放
                // 用户需要手动点击播放按钮才能开始播放
                // 这避免了页面切换或点击时自动恢复播放的问题
                if (state.currentTime) {
                    this.audio.currentTime = state.currentTime;
                }
            }
        } catch (e) {
            console.warn('[GlobalPlayer] 恢复状态失败:', e);
        }
    }

    // 获取当前播放状态（供其他页面调用）
    getState() {
        return {
            episode: this.currentEpisode,
            isPlaying: this.isPlaying,
            currentTime: this.audio ? this.audio.currentTime : 0
        };
    }

    // 关闭播放器
    close() {
        if (this.audio) {
            this.audio.pause();
            this.audio.src = '';
        }
        this.currentEpisode = null;
        this.isPlaying = false;
        
        const playerBar = document.getElementById('globalPlayerBar');
        if (playerBar) {
            playerBar.classList.remove('show');
        }

        // 清除localStorage中的播放状态
        localStorage.removeItem('podcast_playback');
        
        this.broadcast('pause', {});
    }

    // 打开完整播放器
    openFullPlayer() {
        window.location.href = 'audio-player.html';
    }
}

// 全局实例
window.globalPlayer = new GlobalPodcastPlayer();

// 生成全局迷你播放器HTML（供其他页面插入）
function getGlobalPlayerHTML() {
    return `
        <div id="globalPlayerBar" class="global-player-bar">
            <div class="global-player-content">
                <div class="global-player-cover">&#127911;</div>
                <div class="global-player-info">
                    <div class="global-player-title">未选择播放内容</div>
                </div>
                <div class="global-player-controls">
                    <button class="global-player-btn" onclick="globalPlayer.playPrevious()">&#9198;</button>
                    <button class="global-player-btn global-player-play-btn" onclick="globalPlayer.togglePlay()">&#9654;</button>
                    <button class="global-player-btn" onclick="globalPlayer.playNext()">&#9197;</button>
                </div>
                <div class="global-player-progress" onclick="globalPlayer.seekByClick(event)">
                    <div class="global-player-progress-current" style="width: 0%"></div>
                </div>
                <button class="global-player-btn" onclick="globalPlayer.openFullPlayer()" title="完整播放器">&#x26F6;</button>
                <button class="global-player-btn" onclick="globalPlayer.close()" title="关闭">&#10005;</button>
            </div>
        </div>
    `;
}

// 点击进度条跳转
GlobalPodcastPlayer.prototype.seekByClick = function(event) {
    const bar = event.currentTarget;
    const rect = bar.getBoundingClientRect();
    const percent = (event.clientX - rect.left) / rect.width;
    if (this.audio && this.audio.duration) {
        this.seek(percent * this.audio.duration);
    }
};

// 全局CSS样式
function getGlobalPlayerCSS() {
    return `
        <style>
            .global-player-bar {
                position: fixed;
                bottom: 60px;
                left: 0;
                right: 0;
                background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
                border-top: 1px solid rgba(255,255,255,0.1);
                padding: 8px 16px;
                z-index: 49;
                transform: translateY(100%);
                transition: transform 0.3s ease;
            }
            .global-player-bar.show {
                transform: translateY(0);
            }
            .global-player-content {
                max-width: 800px;
                margin: 0 auto;
                display: flex;
                align-items: center;
                gap: 12px;
            }
            .global-player-cover {
                width: 44px;
                height: 44px;
                border-radius: 8px;
                background: linear-gradient(135deg, #e91e63, #9c27b0);
                overflow: hidden;
                display: flex;
                align-items: center;
                justify-content: center;
                color: white;
                font-size: 20px;
                flex-shrink: 0;
            }
            .global-player-cover img {
                width: 100%;
                height: 100%;
                object-fit: cover;
            }
            .global-player-info {
                flex: 1;
                min-width: 0;
            }
            .global-player-title {
                color: white;
                font-size: 14px;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .global-player-controls {
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .global-player-btn {
                background: none;
                border: none;
                color: white;
                font-size: 18px;
                cursor: pointer;
                padding: 4px;
                opacity: 0.9;
                transition: all 0.2s;
            }
            .global-player-btn:hover {
                opacity: 1;
                transform: scale(1.1);
            }
            .global-player-play-btn {
                width: 36px;
                height: 36px;
                background: #e91e63;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 14px;
            }
            .global-player-progress {
                width: 100px;
                height: 4px;
                background: rgba(255,255,255,0.2);
                border-radius: 2px;
                cursor: pointer;
                overflow: hidden;
            }
            .global-player-progress-current {
                height: 100%;
                background: linear-gradient(90deg, #e91e63, #ff4081);
                transition: width 0.1s;
            }
            @media (max-width: 768px) {
                .global-player-bar {
                    bottom: 55px;
                }
            }
            @media (max-width: 600px) {
                .global-player-progress {
                    display: none;
                }
                .global-player-content {
                    gap: 8px;
                }
            }
        </style>
    `;
}

// 初始化全局播放器UI
function initGlobalPlayer() {
    // 插入CSS
    const css = getGlobalPlayerCSS();
    document.head.insertAdjacentHTML('beforeend', css);

    // 插入HTML
    const html = getGlobalPlayerHTML();
    document.body.insertAdjacentHTML('beforeend', html);

    // 确保播放器默认隐藏（如果没有播放内容）
    const playerBar = document.getElementById('globalPlayerBar');
    if (playerBar) {
        playerBar.classList.remove('show');
    }

    // 立即更新UI状态（可能从localStorage恢复播放状态）
    // 使用window.globalPlayer确保在DOMContentLoaded时也能访问
    if (window.globalPlayer && window.globalPlayer.currentEpisode) {
        window.globalPlayer.updateUI();
    }
}

// 页面加载完成后自动初始化
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initGlobalPlayer);
} else {
    initGlobalPlayer();
}
