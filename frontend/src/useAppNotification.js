import { useCallback, useEffect } from 'react';

// A subtle synthesized "ping" using HTML5 AudioContext
const playPingSound = () => {
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        
        const ctx = new AudioContext();
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
        // Only notify and play sound when the tab is hidden
        if (document.hidden) {
            playPingSound();
            
            if ("Notification" in window && Notification.permission === "granted") {
                new Notification(title, {
                    body,
                    icon: '/favicon.svg' // Assuming this exists as per index.html
                });
            }
        }
    }, []);

    return { requestPermission, notify };
};
