import React, { useState, useEffect, useRef } from 'react';
import { USERS } from './users';
import { FiSend, FiImage, FiSmile } from 'react-icons/fi';
import EmojiPicker from 'emoji-picker-react';
import { socket } from './socket';
import { generateECDHKeyPair, exportPrivateKeyJWK, importPrivateKeyJWK, importPublicKey, deriveAESKey, encryptText, decryptText, encryptMedia, decryptMedia } from './crypto';
import { PillAvatar } from './PillAvatar';
import { useAppNotification } from './useAppNotification';

import { auth, provider, storage } from './firebase';
import { signInWithPopup } from "firebase/auth";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";

// In dev, use relative /api so Vite proxies to backend (avoids CORS and "Failed to fetch")
const API_BASE = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? "/api" : "https://my-secure-chat.onrender.com/api");
const API_URL = `${API_BASE}/auth`;

function App() {
  const [messages, setMessages] = useState([]);
  const [decryptedMessages, setDecryptedMessages] = useState([]);
  const [activeUsers, setActiveUsers] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [groups, setGroups] = useState([]);
  const [activeGroup, setActiveGroup] = useState(null); // null = global default
  const [showNewGroupForm, setShowNewGroupForm] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupMembers, setNewGroupMembers] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [currentUser, setCurrentUser] = useState(null); 
  const [isConnected, setIsConnected] = useState(false);
  const [loginError, setLoginError] = useState('');
  
  const [typingUsers, setTypingUsers] = useState([]);
  
  // Auth Form State
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authMode, setAuthMode] = useState('login'); // 'login', 'register-google', 'register-password'
  const [googleIdentity, setGoogleIdentity] = useState(null);
  const [isCheckingSession, setIsCheckingSession] = useState(true);

  const chatEndRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const lastNotifiedMsgId = useRef(null);
  const { requestPermission, notify } = useAppNotification();

  useEffect(() => {
    function onConnect() {
      setIsConnected(true);
      console.log('Connected to Relay');
    }

    function onDisconnect() {
      setIsConnected(false);
      console.log('Disconnected from Relay');
    }

    function onReceiveMessage(msg) {
      setMessages(prev => [...prev, msg]);
      scrollToBottom();
    }
    
    function onActiveUsers(users) {
      setActiveUsers(users);
    }
    
    function onUserStatusChange({ uid, status }) {
       setAllUsers(prev => prev.map(u => String(u._id) === String(uid) ? { ...u, status } : u));
    }

    function onUserJoined(user) {
      setActiveUsers(prev => {
        if (prev.find(u => u.uid === user.uid)) return prev;
        return [...prev, user];
      });
      setMessages(prev => [...prev, { id: Date.now().toString(), text: `${user.nickname} joined the room.`, sender: 'system', timestamp: new Date().toISOString() }]);
    }

    function onLoadHistory(history) {
      // Map DB schema back to local state format
      const formattedHistory = history.map(h => ({
        id: h.id,
        encryptedPayloads: h.encryptedPayloads,
        sender: h.senderId,
        senderPublicKey: h.senderPublicKey,
        timestamp: h.timestamp
      }));
      setMessages(formattedHistory);
    }

    function onUserTypingUpdate({ uid, nickname, isTyping }) {
      setTypingUsers(prev => {
        const filtered = prev.filter(u => String(u.uid) !== String(uid));
        if (isTyping) return [...filtered, { uid, nickname }];
        return filtered;
      });
    }

    function onUnauthorized({ message }) {
      console.warn('[!] Unauthorized:', message);
      alert(`[ACCESS DENIED] ${message}`);
      // Kick user back to the open GENERAL channel
      setActiveGroup(null);
      setMessages([]);
      setDecryptedMessages([]);
      socket.emit('join_group', { groupId: 'global' });
    }

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('receive_message', onReceiveMessage);
    socket.on('active_users', onActiveUsers);
    socket.on('user_joined', onUserJoined);
    socket.on('user_status_change', onUserStatusChange);
    socket.on('load_history', onLoadHistory);
    socket.on('user_typing_update', onUserTypingUpdate);
    socket.on('unauthorized', onUnauthorized);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('receive_message', onReceiveMessage);
      socket.off('active_users', onActiveUsers);
        socket.off('user_joined', onUserJoined);
        socket.off('user_status_change', onUserStatusChange);
        socket.off('load_history', onLoadHistory);
        socket.off('user_typing_update', onUserTypingUpdate);
        socket.off('unauthorized', onUnauthorized);
      };
    }, []);

  // Async task to decrypt messages when state changes
  useEffect(() => {
    if (!currentUser || !currentUser.privateKey) return;

    const decryptAll = async () => {
      // Resolve our UID once — must match the key used in encryptedPayloads
      const myUid = String(currentUser.uid ?? currentUser.id ?? currentUser._id ?? '');

      const decrypted = await Promise.all(messages.map(async (msg) => {
        if (msg.sender === 'system') return msg;
        if (msg.decryptedText) return msg;

        const payloads = msg.encryptedPayloads && typeof msg.encryptedPayloads === 'object' ? msg.encryptedPayloads : {};

        // Helper: derive the shared ECDH key between current user (receiver) and sender
        // ECDH guarantee: receiverPriv + senderPub == senderPriv + receiverPub (same shared secret)
        const deriveSharedKey = async () => {
          const senderPubKey = await importPublicKey(msg.senderPublicKey);
          return deriveAESKey(currentUser.privateKey, senderPubKey);
        };

        const tryDecryptTextPayload = async (p) => {
          if (!p || p.cipherText == null || !p.iv) return null;
          try {
            const sharedSecret = await deriveSharedKey();
            return await decryptText(p.cipherText, p.iv, sharedSecret);
          } catch (_) {
            return null;
          }
        };

        // ── STEP 1: Try our own dedicated payload slot first (fastest & most reliable) ──
        // The sender encrypted a slot keyed by our UID; try it directly before brute-forcing.
        // Also check for multi-session variant keys like `${myUid}__2`, `${myUid}__3`, etc.
        const mySlotKeys = Object.keys(payloads).filter(k => k === myUid || k.startsWith(`${myUid}__`));
        for (const key of mySlotKeys) {
          const p = payloads[key];
          if (!p) continue;
          const text = await tryDecryptTextPayload(p);
          if (text != null) return { ...msg, text, decryptedText: true };
        }

        // ── STEP 2: Fallback — try ALL slots (handles messages sent before we joined, legacy history, etc.) ──
        const payloadEntries = Object.entries(payloads).filter(([, p]) => p && typeof p === 'object');
        for (const [, p] of payloadEntries) {
          const text = await tryDecryptTextPayload(p);
          if (text != null) return { ...msg, text, decryptedText: true };
        }

        // ── Could not decrypt — either we were offline when message was sent, or keys rotated ──
        return { ...msg, text: "<Encrypted: Not for you or key missing>", decryptedText: true };
      }));
      setDecryptedMessages(decrypted);

      if (decrypted.length > 0) {
        const newestMsg = decrypted[decrypted.length - 1];
        if (newestMsg.id !== lastNotifiedMsgId.current && newestMsg.sender !== myUid && newestMsg.sender !== 'system') {
          lastNotifiedMsgId.current = newestMsg.id;
          const isRecent = (new Date() - new Date(newestMsg.timestamp)) < 10000;
          if (isRecent) {
            const bodyText = (newestMsg.decryptedText && !newestMsg.text.startsWith('<Encrypted')) ? newestMsg.text : '🔒 Encrypted Message';
            notify('New Encrypted Message', bodyText);
          }
        }
      }
    };

    decryptAll();
  }, [messages, currentUser]);

  // Check persistent session
  useEffect(() => {
    const checkSession = async () => {
      const token = localStorage.getItem('cipherchat_token');
      if (!token) {
        setIsCheckingSession(false);
        return;
      }
      try {
        const res = await fetch(`${API_URL}/me`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) {
          localStorage.removeItem('cipherchat_token');
          setIsCheckingSession(false);
          return;
        }
        const contentType = res.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
          localStorage.removeItem('cipherchat_token');
          setIsCheckingSession(false);
          return;
        }
        const userData = await res.json();
        const userId = String(userData._id ?? userData.id);
        const storageKey = `cipherchat_key_${userId}`;
        const savedKeys = localStorage.getItem(storageKey);

        if (!savedKeys) {
          console.error("Session valid but crypto keys missing locally. Please re-login.");
          localStorage.removeItem('cipherchat_token');
          setIsCheckingSession(false);
          return;
        }

        const parsed = JSON.parse(savedKeys);
        const privateKey = await importPrivateKeyJWK(parsed.jwk);

        const fullUser = {
          ...userData,
          id: userId,
          uid: userId,
          privateKey,
          publicKeyBase64: parsed.publicKeyBase64
        };

        setCurrentUser(fullUser);
        connectToRelay(fullUser);
        fetchInitialData(token); // FIX: Ensure sidebar list populates on page refresh
        requestPermission();
      } catch (err) {
        console.error("Session check failed", err);
        localStorage.removeItem('cipherchat_token');
      }
      setIsCheckingSession(false);
    };
    checkSession();
  }, []);

  const connectToRelay = (user) => {
    socket.connect();
    socket.emit('join_relay', {
        nickname: user.nickname,
        uid: user.uid,
        color1: user.color1,
        color2: user.color2,
        sym: user.sym,
        avatar: user.avatar,
        publicKeyBase64: user.publicKeyBase64
    });
    // Optional: join default global group immediately
    socket.emit('join_group', { groupId: 'global' });
  };

  const fetchInitialData = async (token) => {
    try {
       const uRes = await fetch(`${API_URL}/users`, { headers: { 'Authorization': `Bearer ${token}` } });
       if (uRes.ok) setAllUsers(await uRes.json());
       
       const gRes = await fetch(`${API_BASE}/groups`, { headers: { 'Authorization': `Bearer ${token}` } });
       if (gRes.ok) {
           const g = await gRes.json();
           setGroups(g);
       }
    } catch (e) { console.error('Error fetching initial context', e); }
  };

  const handleGoogleAuth = async () => {
    try {
      const result = await signInWithPopup(auth, provider);
      setGoogleIdentity({
        uid: result.user.uid,
        email: result.user.email
      });
      setAuthMode('register-password');
      setLoginError('');
    } catch (error) {
       console.error("Google Auth error", error);
       setLoginError(error.message);
    }
  };

  const handleAuth = async (e) => {
    e.preventDefault();
    if (!username || !password) return setLoginError('Please enter username and password');
    setLoginError('');
    
    try {
      const isRegistering = authMode === 'register-password';
      const endpoint = isRegistering ? '/register' : '/login';
      const randomUser = USERS[Math.floor(Math.random() * USERS.length)]; // for random theme if registering
      
      const payload = isRegistering ? {
        username,
        password,
        nickname: username,
        color1: randomUser.color1,
        color2: randomUser.color2,
        sym: username.charAt(0).toUpperCase(),
        avatar: randomUser.avatar,
        googleUid: googleIdentity?.uid,
        email: googleIdentity?.email
      } : { username, password };

      const res = await fetch(`${API_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      let data;
      const contentType = res.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        data = await res.json();
      } else {
        const text = await res.text();
        throw new Error(res.ok ? 'Invalid server response' : (text || `Request failed (${res.status})`));
      }
      if (!res.ok) {
        const msg = data.error || 'Authentication failed';
        const detail = data.detail;
        if (res.status === 500) {
          throw new Error(detail || (msg === 'Internal server error'
            ? 'Backend error. Start backend in a terminal: cd my-secure-chat/backend && npm start (and check that terminal for errors).'
            : msg));
        }
        throw new Error(msg);
      }
      if (!data.token || !data.user) throw new Error('Invalid server response');

      const userId = String(data.user.id ?? data.user._id);
      localStorage.setItem('cipherchat_token', data.token);

      let privateKey;
      let publicKeyBase64;
      const storageKey = `cipherchat_key_${userId}`;
      const savedKeys = localStorage.getItem(storageKey);

      if (savedKeys) {
        const parsed = JSON.parse(savedKeys);
        privateKey = await importPrivateKeyJWK(parsed.jwk);
        publicKeyBase64 = parsed.publicKeyBase64;
      } else {
        const kp = await generateECDHKeyPair();
        privateKey = kp.keyPair.privateKey;
        publicKeyBase64 = kp.publicKeyBase64;
        const jwk = await exportPrivateKeyJWK(privateKey);
        localStorage.setItem(storageKey, JSON.stringify({ jwk, publicKeyBase64 }));
      }
      
      const sessionUser = {
        ...data.user,
        id: userId,
        _id: userId,
        uid: userId,
        publicKeyBase64,
        privateKey
      };
      
      setCurrentUser(sessionUser);
      connectToRelay(sessionUser);
      fetchInitialData(data.token);
      requestPermission();
      
    } catch (error) {
      console.error("Auth error", error);
      const isNetworkError = error.message === 'Failed to fetch' || (error.name === 'TypeError' && error.message?.includes?.('fetch'));
      const message = isNetworkError
        ? 'Cannot reach server. Start the backend with: cd my-secure-chat/backend && npm start'
        : (error.message || 'Authentication failed');
      setLoginError(message);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('cipherchat_token');
    socket.disconnect();
    setCurrentUser(null);
    setMessages([]);
    setUsername('');
    setPassword('');
  };

  const scrollToBottom = () => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [decryptedMessages]);

  if (isCheckingSession) {
    return <div className="h-screen bg-pureBlack text-accent flex items-center justify-center font-mono animate-pulse">VERIFYING LOCAL SESSION TOKENS...</div>;
  }

  if (!currentUser) {
    return (
      <div id="auth-page">
        <div className="grid-bg"></div>
        <div className="corner-decoration tl"></div>
        <div className="corner-decoration tr"></div>
        <div className="corner-decoration bl"></div>
        <div className="corner-decoration br"></div>

        <div className="auth-card" style={{ padding: '24px 32px' }}>
          <div className="logo-area" style={{ marginBottom: '16px' }}>
            <div className="pill-logo" style={{ marginBottom: '12px' }}>
              <PillAvatar color1="#00ff9d" color2="#a855f7" symbol="CC" size={50} className="pill-svg" />
            </div>
            <div className="brand-name" style={{ fontSize: '24px' }}>CipherChat</div>
            <div className="text-[10px] text-muted tracking-[3px] uppercase mt-1 font-mono">
              // {authMode === 'login' ? 'SECURE CHANNEL LOGIN' : 'INITIALIZE NEW NODE'} //
            </div>
          </div>

          {loginError && (
             <div className="bg-red-950/20 border border-red-500/30 text-red-500 p-2 text-[10px] font-mono mb-4 text-left">
               [ERROR] {loginError}
             </div>
          )}

          {authMode === 'register-google' && (
            <div className="flex flex-col gap-3">
              <div className="text-[11px] font-mono text-accent mb-2 text-center">
                STEP 1: VERIFY IDENTITY VIA GOOGLE
              </div>
              <button onClick={handleGoogleAuth} className="bg-white text-black font-bold font-mono text-[10px] sm:text-sm px-4 py-3 cursor-pointer hover:bg-gray-200 transition-colors">
                AUTHENTICATE WITH GOOGLE
              </button>
              <button 
                 onClick={() => setAuthMode('login')}
                 className="w-full text-center text-[10px] text-muted font-mono mt-2 hover:text-accent transition-colors cursor-pointer"
              >
                 HAVE AN IDENTITY? LOGIN INSTEAD
              </button>
            </div>
          )}

          {authMode === 'register-password' && (
            <form onSubmit={handleAuth} className="flex flex-col gap-3">
               <div className="text-[11px] font-mono text-accent mb-2 text-center">
                 STEP 2: CREATE LOCAL CREDENTIALS
               </div>
               <input 
                 type="text" 
                 placeholder="OPERATOR_ID (Choose Username)" 
                 value={username}
                 onChange={e => setUsername(e.target.value)}
                 className="bg-[#0a0a0f] border border-[#2a2a3a] text-[#e8e8f0] font-mono text-sm px-4 py-3 focus:outline-none focus:border-[#00ff9d] transition-colors"
               />
               <input 
                 type="password" 
                 placeholder="DECRYPTION_PHRASE (Choose Password)" 
                 value={password}
                 onChange={e => setPassword(e.target.value)}
                 className="bg-[#0a0a0f] border border-[#2a2a3a] text-[#e8e8f0] font-mono text-sm px-4 py-3 focus:outline-none focus:border-[#00ff9d] transition-colors"
               />
               
               <button type="submit" className="auth-btn w-full mt-2">
                 REGISTER IDENTITY
               </button>
               <button 
                 type="button"
                 onClick={() => setAuthMode('login')}
                 className="w-full text-center text-[10px] text-muted font-mono mt-2 hover:text-accent transition-colors cursor-pointer"
               >
                 CANCEL REGISTRATION
               </button>
            </form>
          )}

          {authMode === 'login' && (
            <form onSubmit={handleAuth} className="flex flex-col gap-3">
               <input 
                 type="text" 
                 placeholder="OPERATOR_ID (Username)" 
                 value={username}
                 onChange={e => setUsername(e.target.value)}
                 className="bg-[#0a0a0f] border border-[#2a2a3a] text-[#e8e8f0] font-mono text-sm px-4 py-3 focus:outline-none focus:border-[#00ff9d] transition-colors"
               />
               <input 
                 type="password" 
                 placeholder="DECRYPTION_PHRASE (Password)" 
                 value={password}
                 onChange={e => setPassword(e.target.value)}
                 className="bg-[#0a0a0f] border border-[#2a2a3a] text-[#e8e8f0] font-mono text-sm px-4 py-3 focus:outline-none focus:border-[#00ff9d] transition-colors"
               />
               
               <button type="submit" className="auth-btn w-full mt-2">
                 ACCESS SECURE CHANNEL
               </button>

               <button 
                 type="button"
                 onClick={() => setAuthMode('register-google')}
                 className="w-full text-center text-[10px] text-muted font-mono mt-4 hover:text-accent transition-colors cursor-pointer"
               >
                 NEW OPERATOR? REGISTER HERE
               </button>
            </form>
          )}

          <div className="mt-5 text-center font-mono text-[9px] text-[#2a2a3a] tracking-[1px]">
            ALL MESSAGES ENCRYPTED · NO LOGS · AES-GCM-256
          </div>
        </div>
      </div>
    );
  }

  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (newMessage.trim() === '') return;
    
    // Clear typing timeout and emit stopped upon actual send
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    socket.emit('typing_stopped', { 
         groupId: activeGroup ? activeGroup._id : 'global', 
         nickname: currentUser.nickname, 
         uid: String(currentUser.uid ?? currentUser.id ?? currentUser._id) 
    });
    
    const groupId = activeGroup ? activeGroup._id : 'global';
    const usersToEncryptFor = await Promise.race([
      new Promise((resolve) => {
        socket.emit('get_active_users', { groupId }, (users) => {
          resolve(Array.isArray(users) ? users : []);
        });
      }),
      new Promise((resolve) => setTimeout(() => resolve(activeUsers), 2500))
    ]);
    
    const encryptedPayloads = {};
    const myPubKey = await importPublicKey(currentUser.publicKeyBase64);
    const myUid = String(currentUser.uid ?? currentUser.id ?? currentUser._id);
    const seenKeysByUid = {}; // same user can have multiple sessions (tabs) with different keys — encrypt for each

    for (const user of usersToEncryptFor) {
      const uid = String(user?.uid ?? user?.id ?? user?._id ?? '');
      if (!uid || !user?.publicKeyBase64) continue;
      const pubKey = user.publicKeyBase64;
      const keyIndex = (seenKeysByUid[uid] = (seenKeysByUid[uid] || 0) + 1);
      const payloadKey = keyIndex === 1 ? uid : `${uid}__${keyIndex}`;
      try {
        const theirKey = await importPublicKey(pubKey);
        const sharedSecret = await deriveAESKey(currentUser.privateKey, theirKey);
        const { cipherText, iv } = await encryptText(newMessage, sharedSecret);
        encryptedPayloads[payloadKey] = { cipherText, iv };
      } catch (err) {
        console.warn('Skip encrypt for user', uid, err);
      }
    }
    const myShared = await deriveAESKey(currentUser.privateKey, myPubKey);
    const myEnc = await encryptText(newMessage, myShared);
    encryptedPayloads[myUid] = { cipherText: myEnc.cipherText, iv: myEnc.iv };

    const msg = {
      id: Date.now().toString(),
      sender: myUid,
      senderPublicKey: currentUser.publicKeyBase64,
      encryptedPayloads,
      timestamp: new Date().toISOString(),
      groupId
    };
    
    socket.emit('send_message', msg);
    setNewMessage('');
    setShowEmojiPicker(false);
  };

  const handleTypingChange = (e) => {
    const val = e.target.value;
    setNewMessage(val);
    
    if (!currentUser) return;
    const groupId = activeGroup ? activeGroup._id : 'global';
    const uid = String(currentUser.uid ?? currentUser.id ?? currentUser._id);
    
    if (val.trim() !== '') {
       socket.emit('typing_started', { groupId, nickname: currentUser.nickname, uid });
       
       if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
       typingTimeoutRef.current = setTimeout(() => {
           socket.emit('typing_stopped', { groupId, nickname: currentUser.nickname, uid });
       }, 2500);
    } else {
       socket.emit('typing_stopped', { groupId, nickname: currentUser.nickname, uid });
       if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    }
  };

  const onEmojiClick = (emojiObject) => {
    setNewMessage(prevInput => prevInput + emojiObject.emoji);
  };


  const getUser = (id) => {
    const s = String(id);
    return allUsers.find(u => String(u._id) === s) || activeUsers.find(u => String(u.uid ?? u.id ?? u._id) === s) || USERS.find(u => String(u.id) === s);
  };

  const formatTime = (isoString) => {
    const date = new Date(isoString);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  const handleCreateGroup = async (e) => {
    e.preventDefault();
    if (!newGroupName.trim()) return;
    try {
       const token = localStorage.getItem('cipherchat_token');
       const res = await fetch(`${API_BASE}/groups`, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
         body: JSON.stringify({ name: newGroupName, members: newGroupMembers })
       });
       if (res.ok) {
         const newG = await res.json();
         setGroups([...groups, newG]);
         setNewGroupName('');
         setNewGroupMembers([]);
         setShowNewGroupForm(false);
         handleJoinGroup(newG);
       }
    } catch(err) { console.error("Failed to create group", err); }
  };

  const handleJoinGroup = (group) => {
     setActiveGroup(group);
     setMessages([]);
     setDecryptedMessages([]);
     socket.emit('join_group', { groupId: group ? group._id : 'global' });
  };

  const handleRenameGroup = async () => {
    if (!activeGroup) return;
    const newName = prompt("ENTER NEW CHANNEL DESIGNATION:", activeGroup.name);
    if (!newName || !newName.trim() || newName === activeGroup.name) return;
    
    try {
      const token = localStorage.getItem('cipherchat_token');
      const res = await fetch(`${API_BASE}/groups/${activeGroup._id}`, {
         method: 'PUT',
         headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
         body: JSON.stringify({ name: newName.trim() })
      });
      if (res.ok) {
         const updatedG = await res.json();
         setGroups(groups.map(g => g._id === updatedG._id ? updatedG : g));
         setActiveGroup(updatedG);
      } else {
         const data = await res.json();
         alert(data.error || 'Failed to rename group');
      }
    } catch(err) { console.error("Failed to rename group:", err); }
  };

  const handleDeleteGroup = async () => {
    if (!activeGroup) return;
    const confirmDelete = window.confirm(`Are you sure you want to delete ${activeGroup.name}?`);
    if (!confirmDelete) return;

    try {
      const token = localStorage.getItem('cipherchat_token');
      const res = await fetch(`${API_BASE}/groups/${activeGroup._id}`, {
         method: 'DELETE',
         headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
         setGroups(groups.filter(g => g._id !== activeGroup._id));
         handleJoinGroup(null); // Return to GENERAL
      } else {
         const data = await res.json();
         alert(data.error || 'Failed to delete group');
      }
    } catch(err) { console.error("Failed to delete group:", err); }
  };


  return (
    <div id="chat-page" className="flex">
      {showNewGroupForm && (
        <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
          <div className="bg-[#0a0a0f] border border-borderCol w-full max-w-md p-6 relative">
            <button type="button" onClick={() => { setShowNewGroupForm(false); setNewGroupName(''); setNewGroupMembers([]); }} className="absolute text-accent top-4 right-4 text-xs font-mono hover:text-white cursor-pointer">[X]</button>
            <h2 className="text-accent font-mono text-sm mb-4">// CREATE SECURE CHANNEL</h2>
            <form onSubmit={handleCreateGroup} className="flex flex-col gap-4">
               <div>
                  <label className="text-[10px] font-mono text-muted mb-1 block">CHANNEL DESIGNATION</label>
                  <input 
                    type="text" 
                    value={newGroupName} 
                    onChange={e => setNewGroupName(e.target.value)}
                    placeholder="e.g. ALPHA_SQUAD"
                    className="w-full bg-bg border border-borderCol text-text text-xs font-mono p-2 focus:outline-none focus:border-accent"
                  />
               </div>
               <div>
                  <label className="text-[10px] font-mono text-muted mb-1 block">SELECT OPERATORS ({newGroupMembers.length})</label>
                  <div className="max-h-[200px] overflow-y-auto border border-borderCol bg-bg p-2 flex flex-col gap-1">
                     {allUsers.filter(u => u._id !== currentUser.uid).map(user => {
                        const isSelected = newGroupMembers.includes(user._id);
                        return (
                          <div 
                            key={user._id} 
                            onClick={() => {
                               setNewGroupMembers(prev => 
                                 isSelected ? prev.filter(id => id !== user._id) : [...prev, user._id]
                               );
                            }}
                            className={`flex items-center justify-between p-2 text-xs font-mono cursor-pointer border ${isSelected ? 'border-accent bg-[rgba(0,255,157,0.1)] text-accent' : 'border-transparent text-muted hover:bg-surface2 hover:text-text'}`}
                          >
                             <div className="flex items-center gap-2">
                               <img src={user.avatar} alt={user.nickname} className="w-6 h-6 rounded-full overflow-hidden object-cover border border-borderCol bg-black" />
                               <span>{user.nickname}</span>
                             </div>
                             <div>{isSelected ? '[✓]' : '[ ]'}</div>
                          </div>
                        )
                     })}
                  </div>
               </div>
               <button type="submit" disabled={!newGroupName.trim() || newGroupMembers.length === 0} className="w-full text-bg bg-accent p-2 text-xs font-mono font-bold mt-2 hover:bg-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer">INITIALIZE CHANNEL</button>
            </form>
          </div>
        </div>
      )}
      <nav className="chat-nav">
        <div className="nav-brand">
          <PillAvatar color1="#00ff9d" color2="#a855f7" symbol="CC" size={28} className="nav-pill" />
          <span className="nav-title">CipherChat</span>
          <span className="enc-badge hidden sm:block">E2E ENCRYPTED</span>
        </div>

        <div className="nav-channel hidden md:flex">
          <div className="channel-dot"></div>
          <span># {activeGroup ? activeGroup.name.toUpperCase() : 'GENERAL — SECURE GROUP'}</span>
        </div>

        <div className="nav-actions">
          <div className="nav-user hidden sm:flex">
            <img src={currentUser.avatar} alt={currentUser.nickname} className="w-[30px] h-[30px] rounded-full border border-accent object-cover p-[2px]" />
            <span id="nav-name">{currentUser.nickname}</span>
          </div>
          <button 
            onClick={handleLogout} 
            className="bg-[rgba(255,45,120,0.1)] border border-[rgba(255,45,120,0.3)] text-[#ff2d78] font-mono text-[10px] px-2 py-1 cursor-pointer tracking-[1px] hover:bg-[#ff2d78] hover:text-white transition-colors"
          >
            EXIT
          </button>
        </div>
      </nav>

      <div className="chat-layout">
        <aside className="sidebar hidden sm:flex flex-col gap-4 overflow-y-auto">
          
          <div className="groups-section">
             <div className="flex items-center justify-between sidebar-header mb-2">
                 <span>// SECURE CHANNELS //</span>
                 <button onClick={() => setShowNewGroupForm(!showNewGroupForm)} className="text-accent hover:text-white transition-colors px-2 py-1 bg-surface2 text-xs">+</button>
             </div>
             <div className="flex flex-col mt-4">
                <div 
                   onClick={() => handleJoinGroup(null)}
                   className={`px-3 py-2 text-xs font-mono cursor-pointer transition-colors border-l-2 custom-menu-item mb-1 ${!activeGroup ? 'border-accent bg-[rgba(0,255,157,0.05)] text-accent' : 'border-transparent text-muted hover:bg-surface2 hover:text-text'}`}
                >
                  # GENERAL
                </div>
                {groups.map(g => (
                  <div 
                     key={g._id}
                     onClick={() => handleJoinGroup(g)}
                     className={`px-3 py-2 text-xs font-mono cursor-pointer transition-colors border-l-2 custom-menu-item mb-1 ${activeGroup && activeGroup._id === g._id ? 'border-accent bg-[rgba(0,255,157,0.05)] text-accent' : 'border-transparent text-muted hover:bg-surface2 hover:text-text'}`}
                  >
                    # {g.name.toUpperCase()}
                  </div>
                ))}
             </div>
          </div>

          <div className="users-section mt-4 border-t border-borderCol pt-4">
            <div className="sidebar-header">// GLOBAL OPERATORS — {allUsers.filter(u => u.status === 'online').length} ONLINE //</div>
            <div className="members-list mt-2">
               {allUsers.map(user => {
                  const isMe = currentUser.uid === user._id;
                  const isOnline = user.status === 'online';
                  return (
                    <div key={user._id} className={`member-item ${isMe ? 'active' : ''} ${!isOnline ? 'opacity-50' : ''}`}>
                       <div className={`member-avatar ${isOnline ? 'online' : ''} bg-pureBlack flex items-center justify-center overflow-hidden`}>
                          <img src={user.avatar} alt={user.nickname} className="w-full h-full object-cover" />
                       </div>
                       <div className="member-info">
                         <div className="member-name">{user.nickname} {isMe && <span className="text-[9px] text-accent font-mono ml-1">(you)</span>}</div>
                         <div className={`font-mono text-[9px] ${isOnline ? 'text-accent' : 'text-muted'}`}>{isOnline ? 'online' : 'offline'}</div>
                       </div>
                    </div>
                  )
               })}
            </div>
          </div>
        </aside>

        <div className="chat-area relative flex-1">
          <div className="chat-header">
            <div className="chat-header-left flex gap-3 items-center">
              <div className="group-icon">GRP</div>
              <div>
                <div className="flex items-center gap-2">
                   <div className="group-name"># {activeGroup ? activeGroup.name.toUpperCase() : 'SECURE GROUP'}</div>
                   {activeGroup && (
                     <div className="flex gap-2 items-center">
                       <button 
                          onClick={handleRenameGroup}
                          className="text-[9px] font-mono text-accent border border-accent/20 px-1 py-0.5 hover:bg-accent hover:text-bg transition-colors cursor-pointer"
                       >
                          [RENAME]
                       </button>
                       <button 
                          onClick={handleDeleteGroup}
                          className="text-[9px] font-mono text-[#ff2d78] border border-[#ff2d78]/20 px-1 py-0.5 hover:bg-[#ff2d78] hover:text-white transition-colors cursor-pointer"
                       >
                          [DELETE]
                       </button>
                     </div>
                   )}
                </div>
                <div className="group-meta hidden sm:block">end-to-end encrypted · ephemeral</div>
              </div>
            </div>
            <div className="header-badges">
              <span className="badge e2e hidden sm:block">🔒 AES-256</span>
              <span className="badge members" id="online-badge">● {activeUsers.length} ONLINE</span>
            </div>
          </div>

          <div className="messages-container" id="messages-container">
            <div className="day-divider">TODAY · ENCRYPTED SESSION</div>
            
            {decryptedMessages.map((msg, index) => {
              if (msg.sender === 'system') {
                return (
                  <div key={msg.id} className="msg-group w-full flex justify-center mb-6 mt-4">
                    <div className="msg-bubble system w-full">— {msg.text.toUpperCase()} —</div>
                  </div>
                );
              }

              const sender = getUser(msg.sender) || { nickname: "Unknown", color1: "#888", color2: "#444", sym: "?", avatar: "/avatars/user1.png" };
              const isMe = msg.sender === currentUser.uid;

              return (
                <div key={msg.id} className={`msg-group ${isMe ? 'own' : ''}`}>
                  <div className="msg-avatar overflow-hidden rounded-full self-end border border-borderCol bg-pureBlack flex items-center justify-center -mb-8 z-10">
                    <img src={sender.avatar} alt={sender.nickname} className="w-full h-full object-cover" />
                  </div>
                  <div className="msg-content">
                    <div className="msg-meta">
                      <span className="msg-sender" style={{ color: sender.color1 }}>{isMe ? currentUser.nickname : sender.nickname}</span>
                      <span>{formatTime(msg.timestamp)}</span>
                    </div>
                    
                    <div className="msg-bubble shadow-sm">
                       {msg.text}
                    </div>
                  </div>
                </div>
              );
            })}
            <div ref={chatEndRef} className="h-4" />
          </div>

          <div className="input-area w-full bg-surface z-20">
            {showEmojiPicker && (
               <div className="absolute bottom-[80px] left-4 z-50 shadow-2xl">
                  <EmojiPicker 
                    onEmojiClick={onEmojiClick}
                    theme="dark"
                    searchDisabled
                    skinTonesDisabled
                    lazyLoadEmojis
                  />
               </div>
            )}
            <form onSubmit={handleSendMessage} className="w-full relative">
               {typingUsers.length > 0 && (
                 <div className="absolute -top-7 left-4 text-[10px] font-mono text-accent flex items-center gap-1 bg-[#0a0a0f] px-2 py-1 border border-borderCol">
                   {typingUsers.length === 1 
                     ? `${typingUsers[0].nickname} is typing` 
                     : typingUsers.length === 2 
                       ? `${typingUsers[0].nickname} and 1 other are typing` 
                       : `${typingUsers[0].nickname} and ${typingUsers.length - 1} others are typing`}
                   <span className="flex gap-[2px] ml-1">
                     <div className="w-1 h-1 bg-accent rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
                     <div className="w-1 h-1 bg-accent rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
                     <div className="w-1 h-1 bg-accent rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
                   </span>
                 </div>
               )}
               <div className="input-wrapper focus-within:border-[rgba(0,255,157,0.4)] border border-borderCol bg-surface2 transition-colors">
                 <span className="input-prefix text-accent px-1">›</span>
                 
                 <button 
                   type="button" 
                   className="p-1.5 pr-2 text-muted hover:text-white transition-colors cursor-pointer"
                   onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                 >
                   <FiSmile size={15} />
                 </button>

                 <textarea
                   id="msg-input"
                   value={newMessage}
                   onChange={handleTypingChange}
                   onKeyDown={(e) => {
                     if (e.key === 'Enter' && !e.shiftKey) {
                       e.preventDefault();
                       handleSendMessage(e);
                     }
                   }}
                   placeholder="type encrypted message..."
                   rows={1}
                 />
                 
                 <button 
                   type="submit" 
                   disabled={!newMessage.trim()}
                   className="send-btn bg-accent hover:bg-[#00ffb0] text-bg disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                 >
                   <FiSend size={15} />
                 </button>
               </div>
               
               <div className="input-footer text-gray-400 hidden sm:flex opacity-80 mt-2">
                 <span>CHANNEL: #SECURE-GROUP · ENCRYPTION: ON · RELAY: TOR</span>
                 <span className="typing-indicator text-accent3">{newMessage.trim() && `${currentUser.nickname} is writing...`}</span>
               </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
