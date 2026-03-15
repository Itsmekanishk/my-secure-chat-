import { useCallback, useEffect } from 'react';

// A subtle synthesized "ping" using HTML5 AudioContext
const playPingSound = () => {
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        
        // browsers require audio context to be resumed if suspended
        const ctx = new AudioContext();
        if (ctx.state === 'suspended') {
            ctx.resume();
        }

        const osc = ctx.createOscillator();
        const gainNode = ctx.createGain();

        osc.connect(gainNode);
        gainNode.connect(ctx.destination);

        // Ping sound configuration
        osc.type = 'sine';
        osc.frequency.setValueAtTime(800, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.1);

        gainNode.gain.setValueAtTime(0, ctx.currentTime);
        gainNode.gain.linearRampToValueAtTime(0.5, ctx.currentTime + 0.05); // quick attack
        gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4); // slightly longer decay

        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.5);
    } catch (err) {
        console.warn('Failed to play audio ping', err);
    }
};

export const useAppNotification = () => {
    const requestPermission = useCallback(async () => {
        if (!("Notification" in window)) {
            console.warn("Browser does not support desktop notification");
            return false;
        }

        if (Notification.permission === "granted") {
            return true;
        }

        if (Notification.permission !== "denied") {
            const permission = await Notification.requestPermission();
            return permission === "granted";
        }

        return false;
    }, []);

    const notify = useCallback((title, body) => {
        // ALWAYS play the sound ping for incoming messages
        playPingSound();

        // ONLY show the visual desktop notification if the tab is hidden
        if (document.hidden) {
            if ("Notification" in window && Notification.permission === "granted") {
                // Try Service Worker registration first for native PWA behavior
                if ('serviceWorker' in navigator) {
                    navigator.serviceWorker.ready.then((registration) => {
                        registration.showNotification(title, {
                            body,
                            icon: '/favicon.svg',
                            badge: '/favicon.svg',
                            vibrate: [200, 100, 200]
                        });
                    }).catch(() => {
                        // Fallback
                        new Notification(title, { body, icon: '/favicon.svg' });
                    });
                } else {
                    new Notification(title, { body, icon: '/favicon.svg' });
                }
            }
        }
    }, []);

    return { requestPermission, notify };
};
