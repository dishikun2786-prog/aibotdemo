/**
 * AudioManager - 音效管理器
 * 统一管理游戏中的所有音效播放
 */
class AudioManager {
    constructor() {
        this.sounds = {};
        this.volume = 0.5;
        this.muted = false;
        this.enabled = true;
        this.currentLoopSound = null;
        this.initialized = false;
    }

    /**
     * 初始化 - 预加载所有音效
     */
    init() {
        if (this.initialized) return;
        
        const soundFiles = [
            // UI交互
            { key: 'ui_click', file: 'ui/click' },
            { key: 'ui_hover', file: 'ui/hover' },
            { key: 'ui_switch', file: 'ui/switch' },
            { key: 'ui_error', file: 'ui/error' },
            { key: 'ui_success', file: 'ui/success' },
            
            // 玩家行为
            { key: 'player_join', file: 'player/join' },
            { key: 'player_leave', file: 'player/leave' },
            { key: 'player_login', file: 'player/login' },
            
            // 节点相关
            { key: 'node_occupy', file: 'node/occupy' },
            { key: 'node_occupy_fail', file: 'node/occupy_fail' },
            { key: 'node_release', file: 'node/release' },
            
            // 挖矿
            { key: 'mining_start', file: 'mining/mining_start' },
            { key: 'mining_loop', file: 'mining/mining_loop' },
            { key: 'energy_up', file: 'mining/energy_up' },
            
            // 宝藏
            { key: 'treasure_found', file: 'treasure/treasure_found' },
            { key: 'treasure_claim', file: 'treasure/claim' },
            { key: 'treasure_hint', file: 'treasure_hint' },
            
            // PK对战
            { key: 'pk_challenge', file: 'pk/challenge' },
            { key: 'pk_challenge_received', file: 'pk/challenge_received' },
            { key: 'pk_reject', file: 'pk/reject' },
            { key: 'pk_battle_start', file: 'pk/battle_start' },
            { key: 'pk_win', file: 'pk/win' },
            { key: 'pk_lose', file: 'pk/lose' },
            { key: 'pk_draw', file: 'pk/draw' },
            
            // AI智能体
            { key: 'ai_appear', file: 'ai/ai_appear' },
            { key: 'ai_message', file: 'ai/message' },
            { key: 'ai_thinking', file: 'ai/thinking' },
            
            // 剧情系统
            { key: 'story_chapter_unlock', file: 'story/chapter_unlock' },
            { key: 'story_task_complete', file: 'story/task_complete' },
            { key: 'story_reward', file: 'story/reward' }
        ];
        
        for (const item of soundFiles) {
            const audio = new Audio(`/sounds/${item.file}.ogg`);
            audio.preload = 'auto';
            this.sounds[item.key] = audio;
        }
        
        this.initialized = true;
        console.log('[AudioManager] 音效管理器已初始化');
    }

    /**
     * 播放音效
     * @param {string} name - 音效名称
     * @param {Object} options - 选项
     * @param {number} options.volume - 音量 (0-1)
     * @param {number} options.playbackRate - 播放速度
     */
    play(name, options = {}) {
        if (!this.enabled || this.muted) return;
        
        const sound = this.sounds[name];
        if (!sound) {
            console.warn(`[AudioManager] 音效不存在: ${name}`);
            return;
        }
        
        try {
            sound.volume = options.volume !== undefined ? options.volume : this.volume;
            sound.currentTime = 0;
            
            if (options.playbackRate) {
                sound.playbackRate = options.playbackRate;
            }
            
            sound.play().catch(e => {
                // 忽略用户交互限制错误
                if (e.name !== 'NotAllowedError') {
                    console.warn(`[AudioManager] 播放失败: ${name}`, e);
                }
            });
        } catch (e) {
            console.warn(`[AudioManager] 播放异常: ${name}`, e);
        }
    }

    /**
     * 循环播放音效（用于挖矿背景音）
     * @param {string} name - 音效名称
     * @returns {HTMLAudioElement|null}
     */
    playLoop(name) {
        if (!this.enabled || this.muted) return null;
        
        // 停止当前循环
        this.stopLoop();
        
        const sound = this.sounds[name];
        if (!sound) {
            console.warn(`[AudioManager] 循环音效不存在: ${name}`);
            return null;
        }
        
        try {
            sound.volume = this.volume;
            sound.loop = true;
            sound.play().catch(e => {
                if (e.name !== 'NotAllowedError') {
                    console.warn(`[AudioManager] 循环播放失败: ${name}`, e);
                }
            });
            this.currentLoopSound = sound;
            return sound;
        } catch (e) {
            console.warn(`[AudioManager] 循环播放异常: ${name}`, e);
            return null;
        }
    }

    /**
     * 停止循环播放
     */
    stopLoop() {
        if (this.currentLoopSound) {
            this.currentLoopSound.pause();
            this.currentLoopSound.currentTime = 0;
            this.currentLoopSound.loop = false;
            this.currentLoopSound = null;
        }
    }

    /**
     * 设置音量
     * @param {number} value - 音量 (0-1)
     */
    setVolume(value) {
        this.volume = Math.max(0, Math.min(1, value));
        // 更新当前循环音效的音量
        if (this.currentLoopSound) {
            this.currentLoopSound.volume = this.volume;
        }
    }

    /**
     * 切换静音状态
     * @returns {boolean} 新的静音状态
     */
    toggleMute() {
        this.muted = !this.muted;
        if (this.muted) {
            this.stopLoop();
        }
        return this.muted;
    }

    /**
     * 启用/禁用音效
     * @param {boolean} enabled 
     */
    setEnabled(enabled) {
        this.enabled = enabled;
        if (!enabled) {
            this.stopLoop();
        }
    }

    /**
     * 根据消息内容自动播放合适的音效
     * @param {string} message - 系统消息内容
     */
    playByMessage(message) {
        if (!message || !this.enabled || this.muted) return;
        
        const msg = message.toLowerCase();
        
        if (msg.includes('成功占据') || msg.includes('占据节点')) {
            this.play('node_occupy');
        } else if (msg.includes('占据失败') || msg.includes('无法占据')) {
            this.play('node_occupy_fail');
        } else if (msg.includes('释放') || msg.includes('离开节点')) {
            this.play('node_release');
        } else if (msg.includes('开始挖掘') || msg.includes('挖掘中')) {
            this.play('mining_start');
        } else if (msg.includes('发现宝藏') || msg.includes('发现能量')) {
            this.play('treasure_found');
        } else if (msg.includes('领取宝藏') || msg.includes('获得能量')) {
            this.play('treasure_claim');
        } else if (msg.includes('挑战') && (msg.includes('pk') || msg.includes('对战'))) {
            this.play('pk_challenge_received');
        } else if (msg.includes('战斗开始') || msg.includes('pk开始')) {
            this.play('pk_battle_start');
        } else if (msg.includes('胜利') || msg.includes('获胜')) {
            this.play('pk_win');
        } else if (msg.includes('失败') || msg.includes('输了')) {
            this.play('pk_lose');
        } else if (msg.includes('平局')) {
            this.play('pk_draw');
        } else if (msg.includes('章节解锁') || msg.includes('解锁章节')) {
            this.play('story_chapter_unlock');
        } else if (msg.includes('任务完成') || msg.includes('完成任务')) {
            this.play('story_task_complete');
        } else if (msg.includes('获得奖励') || msg.includes('奖励发放')) {
            this.play('story_reward');
        } else if (msg.includes('登录') || msg.includes('欢迎')) {
            this.play('player_login');
        }
    }
}

// 全局音效管理器实例
const audioManager = new AudioManager();
