import { useEffect, useRef, useState } from 'react';
import './App.css';

type Region = { x: number; y: number; w: number; h: number };
type DragMode = 'move' | 'nw' | 'ne' | 'sw' | 'se' | null;

type SavedRecording = {
  id: string;
  name: string;
  url: string;
  createdAt: string;
};

type StoredRecording = {
  id: string;
  name: string;
  blob: Blob;
  createdAt: string;
};

const RECORDINGS_DB = 'captureflow-recordings';
const RECORDINGS_STORE = 'recordings';

function openRecordingsDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(RECORDINGS_DB, 1);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(RECORDINGS_STORE)) {
        db.createObjectStore(RECORDINGS_STORE, {
          keyPath: 'id'
        });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveRecordingToDB(recording: StoredRecording): Promise<void> {
  const db = await openRecordingsDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(RECORDINGS_STORE, 'readwrite');

    transaction.objectStore(RECORDINGS_STORE).put(recording);

    transaction.oncomplete = () => {
      db.close();
      resolve();
    };

    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };

    transaction.onabort = () => {
      db.close();
      reject(transaction.error);
    };
  });
}

async function getRecordingsFromDB(): Promise<StoredRecording[]> {
  const db = await openRecordingsDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(RECORDINGS_STORE, 'readonly');

    const request = transaction.objectStore(RECORDINGS_STORE).getAll();

    request.onsuccess = () => {
      const results = request.result as StoredRecording[];
      db.close();
      resolve(results);
    };

    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

async function deleteRecordingFromDB(id: string): Promise<void> {
  const db = await openRecordingsDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(RECORDINGS_STORE, 'readwrite');

    transaction.objectStore(RECORDINGS_STORE).delete(id);

    transaction.oncomplete = () => {
      db.close();
      resolve();
    };

    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
}

const FREE_LIMIT = 5;
const COUNT_KEY = 'captureflow-free-count';
const EMAIL_KEY = 'captureflow-registered-email';

function readCount() {
  try {
    const n = Number(localStorage.getItem(COUNT_KEY) || 0);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

function readEmail() {
  try {
    return localStorage.getItem(EMAIL_KEY) || '';
  } catch {
    return '';
  }
}

export default function App() {
  // Theme: dark by default
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const isDark = theme === 'dark';
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const micRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const canvasStreamRef = useRef<MediaStream | null>(null);
  const drawFrameRef = useRef<number | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const regionRef = useRef<Region>({ x: 15, y: 15, w: 65, h: 65 });
  const countRef = useRef(readCount());
  const emailRef = useRef(readEmail());

  const dragRef = useRef<{
    mode: DragMode;
    startX: number;
    startY: number;
    initial: Region;
  }>({
    mode: null,
    startX: 0,
    startY: 0,
    initial: { x: 15, y: 15, w: 65, h: 65 }
  });

  const [region, setRegion] = useState<Region>(regionRef.current);
  const [micEnabled, setMicEnabled] = useState(true);
  const [systemAudio, setSystemAudio] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [message, setMessage] = useState('Ready to capture');

  const [recordings, setRecordings] = useState<SavedRecording[]>([]);
  const [completedCount, setCompletedCount] = useState(readCount);
  const [registeredEmail, setRegisteredEmail] = useState(readEmail);
  const [showEmailModal, setShowEmailModal] = useState(
    () => readCount() >= FREE_LIMIT && !readEmail()
  );
  const [emailInput, setEmailInput] = useState('');
  const [emailError, setEmailError] = useState('');
  const [activeRecordingId, setActiveRecordingId] = useState<string | null>(
    null
  );
  const [showLibrary, setShowLibrary] = useState(false);

  useEffect(() => {
    regionRef.current = region;
  }, [region]);

  useEffect(() => {
    countRef.current = completedCount;

    try {
      localStorage.setItem(COUNT_KEY, String(completedCount));
    } catch {
      // Recording remains usable if storage is unavailable.
    }
  }, [completedCount]);

  useEffect(() => {
    emailRef.current = registeredEmail;
  }, [registeredEmail]);

  useEffect(() => {
    if (!recording) {
      setElapsed(0);
      return;
    }

    const id = window.setInterval(() => {
      setElapsed((n) => n + 1);
    }, 1000);

    return () => window.clearInterval(id);
  }, [recording]);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      micRef.current?.getTracks().forEach((t) => t.stop());
      recordingStreamRef.current?.getTracks().forEach((t) => t.stop());

      if (drawFrameRef.current !== null) {
        cancelAnimationFrame(drawFrameRef.current);
        drawFrameRef.current = null;
      }

      canvasStreamRef.current?.getTracks().forEach((track) => track.stop());
      canvasStreamRef.current = null;

      if (audioContextRef.current) {
        void audioContextRef.current.close().catch(() => {});
      }

      recordings.forEach((item) => URL.revokeObjectURL(item.url));
    };
    // Cleanup only when the component unmounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    let loadedUrls: string[] = [];

    async function restoreRecordings() {
      try {
        const saved = await getRecordingsFromDB();

        if (cancelled) return;

        const restored: SavedRecording[] = saved.map((item) => {
          const url = URL.createObjectURL(item.blob);
          loadedUrls.push(url);

          return {
            id: item.id,
            name: item.name,
            url,
            createdAt: item.createdAt
          };
        });

        setRecordings(restored);

        // Select the most recent saved recording.
        if (restored.length > 0) {
          setActiveRecordingId(restored[restored.length - 1].id);
        }
      } catch (error) {
        console.error('Unable to restore recordings:', error);
        setMessage('Could not load saved recordings.');
      }
    }

    void restoreRecordings();

    return () => {
      cancelled = true;
      loadedUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  const time = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(
    elapsed % 60
  ).padStart(2, '0')}`;

  function updateRegion(next: Region) {
    const w = Math.max(15, Math.min(100, next.w));
    const h = Math.max(15, Math.min(100, next.h));

    const bounded: Region = {
      w,
      h,
      x: Math.max(0, Math.min(100 - w, next.x)),
      y: Math.max(0, Math.min(100 - h, next.y))
    };

    regionRef.current = bounded;
    setRegion(bounded);
  }

  // DELETE RECORDING
  function deleteRecording(item: SavedRecording) {
    const confirmed = window.confirm(
      `Delete "${item.name}"? This action cannot be undone.`
    );

    if (!confirmed) return;

    URL.revokeObjectURL(item.url);

    setRecordings((previous) =>
      previous.filter((recording) => recording.id !== item.id)
    );

    setActiveRecordingId((current) => (current === item.id ? null : current));

    setMessage(`Deleted ${item.name}.`);
  }

  async function shareScreen() {
    if (recording) return;

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: systemAudio
      });

      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = stream;

      if (videoRef.current) {
        const previewVideo = videoRef.current;

        // Attach the live screen-sharing stream.
        previewVideo.srcObject = stream;
        previewVideo.muted = true;
        previewVideo.autoplay = true;
        previewVideo.playsInline = true;

        // Wait until the browser has video dimensions.
        await new Promise<void>((resolve, reject) => {
          if (previewVideo.videoWidth > 0) {
            resolve();
            return;
          }

          const handleReady = () => {
            cleanup();
            resolve();
          };

          const handleError = () => {
            cleanup();
            reject(new Error('The shared-screen preview failed to load.'));
          };

          const cleanup = () => {
            previewVideo.removeEventListener('loadedmetadata', handleReady);
            previewVideo.removeEventListener('error', handleError);
          };

          previewVideo.addEventListener('loadedmetadata', handleReady, {
            once: true
          });

          previewVideo.addEventListener('error', handleError, {
            once: true
          });
        });

        // Explicitly start playback.
        await previewVideo.play();

        console.log('Preview video:', {
          width: previewVideo.videoWidth,
          height: previewVideo.videoHeight,
          paused: previewVideo.paused,
          readyState: previewVideo.readyState,
          tracks: stream.getVideoTracks().map((track) => ({
            state: track.readyState,
            muted: track.muted
          }))
        });
      }

      stream.getVideoTracks()[0]?.addEventListener(
        'ended',
        () => {
          setSharing(false);

          if (recorderRef.current?.state === 'recording') {
            recorderRef.current.stop();
          }

          setMessage('Screen sharing ended.');
        },
        { once: true }
      );

      setSharing(true);
      setMessage('Screen shared — adjust your capture area.');
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'Unable to share screen'
      );
    }
  }

  // IMPROVED DRAGGING: CAPTURE POINTER ON THE FRAME
  function startDrag(e: React.PointerEvent<HTMLDivElement>, mode: DragMode) {
    if (recording || !mode) return;

    e.preventDefault();
    e.stopPropagation();

    const frame = e.currentTarget.closest(
      '.capture-frame'
    ) as HTMLDivElement | null;

    try {
      frame?.setPointerCapture(e.pointerId);
    } catch {
      // Continue without pointer capture if unavailable.
    }

    dragRef.current = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      initial: { ...regionRef.current }
    };
  }

  function moveDrag(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;

    // Do not move or resize while recording.
    if (!drag.mode || recording) return;

    // FIX: Get the preview stage from the capture frame's parent.
    // This ensures movement is calculated against the preview,
    // rather than against the capture frame itself.
    const stage = e.currentTarget.parentElement;
    if (!stage) return;

    const bounds = stage.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;

    // Convert pointer movement into percentages of the preview stage.
    const dx = ((e.clientX - drag.startX) / bounds.width) * 100;
    const dy = ((e.clientY - drag.startY) / bounds.height) * 100;

    const r = drag.initial;

    if (drag.mode === 'move') {
      // FIX: Keep the entire capture frame inside the preview.
      const x = Math.max(0, Math.min(100 - r.w, r.x + dx));
      const y = Math.max(0, Math.min(100 - r.h, r.y + dy));

      updateRegion({
        ...r,
        x,
        y
      });

      return;
    }

    // Resize the frame while preserving its opposite corner.
    let left = r.x;
    let top = r.y;
    let right = r.x + r.w;
    let bottom = r.y + r.h;

    if (drag.mode.includes('w')) left += dx;
    if (drag.mode.includes('e')) right += dx;
    if (drag.mode.includes('n')) top += dy;
    if (drag.mode.includes('s')) bottom += dy;

    // Minimum frame size: 10% in each direction.
    const minSize = 10;

    if (drag.mode.includes('w')) {
      left = Math.max(0, Math.min(right - minSize, left));
    }

    if (drag.mode.includes('e')) {
      right = Math.min(100, Math.max(left + minSize, right));
    }

    if (drag.mode.includes('n')) {
      top = Math.max(0, Math.min(bottom - minSize, top));
    }

    if (drag.mode.includes('s')) {
      bottom = Math.min(100, Math.max(top + minSize, bottom));
    }

    updateRegion({
      x: left,
      y: top,
      w: right - left,
      h: bottom - top
    });
  }

  function stopDrag(e?: React.PointerEvent<HTMLDivElement>) {
    dragRef.current.mode = null;

    if (e) {
      const frame = e.currentTarget.closest(
        '.capture-frame'
      ) as HTMLDivElement | null;

      try {
        if (frame?.hasPointerCapture(e.pointerId)) {
          frame.releasePointerCapture(e.pointerId);
        }
      } catch {
        // Pointer capture may already have been released.
      }
    }
  }

  function registerEmail() {
    const email = emailInput.trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setEmailError('Please enter a valid email address.');
      return;
    }

    try {
      localStorage.setItem(EMAIL_KEY, email);
    } catch {
      setEmailError('Could not save your email in this browser.');
      return;
    }

    emailRef.current = email;
    setRegisteredEmail(email);
    setEmailInput('');
    setEmailError('');
    setShowEmailModal(false);
    setMessage('Email registered. You can continue recording.');
  }

  async function toggleRecording() {
    if (recording) {
      if (recorderRef.current?.state === 'recording') {
        recorderRef.current.stop();
      }
      return;
    }

    if (countRef.current >= FREE_LIMIT && !emailRef.current) {
      setShowEmailModal(true);
      setMessage('Register your email before starting another recording.');
      return;
    }

    let micStream: MediaStream | null = null;
    let audioContext: AudioContext | null = null;
    let localCanvasStream: MediaStream | null = null;
    let localRecordingStream: MediaStream | null = null;
    let drawLoopStarted = false;

    try {
      let screenStream = streamRef.current;

      if (
        !screenStream ||
        !screenStream.getVideoTracks().some((t) => t.readyState === 'live')
      ) {
        screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: 30 },
          audio: systemAudio
        });

        streamRef.current = screenStream;

        if (videoRef.current) {
          videoRef.current.srcObject = screenStream;
          await videoRef.current.play();
        }

        setSharing(true);
      }

      const sourceVideo = videoRef.current;

      if (!sourceVideo) {
        throw new Error('Screen preview is unavailable.');
      }

      // Wait for the browser to expose the real captured video dimensions.
      const waitForVideo = async () => {
        const deadline = Date.now() + 10000;

        while (sourceVideo.videoWidth === 0 || sourceVideo.videoHeight === 0) {
          if (Date.now() > deadline) {
            throw new Error(
              'The shared screen is not ready. Please share it again.'
            );
          }

          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve())
          );
        }
      };

      await waitForVideo();

      const sourceWidth = sourceVideo.videoWidth;
      const sourceHeight = sourceVideo.videoHeight;

      // Freeze the chosen area when recording starts.
      const selected = { ...regionRef.current };

      const cropX = Math.max(
        0,
        Math.min(sourceWidth - 1, Math.round((selected.x / 100) * sourceWidth))
      );

      const cropY = Math.max(
        0,
        Math.min(
          sourceHeight - 1,
          Math.round((selected.y / 100) * sourceHeight)
        )
      );

      const cropWidth = Math.max(
        1,
        Math.min(
          sourceWidth - cropX,
          Math.round((selected.w / 100) * sourceWidth)
        )
      );

      const cropHeight = Math.max(
        1,
        Math.min(
          sourceHeight - cropY,
          Math.round((selected.h / 100) * sourceHeight)
        )
      );

      // The canvas is the actual video source given to MediaRecorder.
      const canvas = document.createElement('canvas');
      canvas.width = cropWidth;
      canvas.height = cropHeight;

      const ctx = canvas.getContext('2d');

      if (!ctx) {
        throw new Error('Unable to create the custom-area recording canvas.');
      }

      const drawFrame = () => {
        if (
          sourceVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
          sourceVideo.videoWidth > 0 &&
          sourceVideo.videoHeight > 0
        ) {
          // Crop the selected rectangle from the original screen video.
          // Output dimensions remain fixed for a stable recording.
          ctx.drawImage(
            sourceVideo,
            cropX,
            cropY,
            cropWidth,
            cropHeight,
            0,
            0,
            canvas.width,
            canvas.height
          );
        }

        drawFrameRef.current = requestAnimationFrame(drawFrame);
      };

      drawFrame();

      // captureStream records only the cropped canvas, not the full screen.
      localCanvasStream = canvas.captureStream(30);
      canvasStreamRef.current = localCanvasStream;
      drawLoopStarted = true;

      const outputTracks: MediaStreamTrack[] = [
        ...localCanvasStream.getVideoTracks()
      ];

      const audioTracks: MediaStreamTrack[] = [];

      if (systemAudio) {
        audioTracks.push(
          ...screenStream
            .getAudioTracks()
            .filter((t) => t.readyState === 'live')
        );
      }

      if (micEnabled) {
        try {
          micStream = await navigator.mediaDevices.getUserMedia({
            audio: true
          });

          micRef.current = micStream;
          audioTracks.push(...micStream.getAudioTracks());
        } catch {
          setMessage('Microphone unavailable. Continuing without microphone.');
        }
      }

      if (audioTracks.length > 0) {
        audioContext = new AudioContext();
        await audioContext.resume();

        const destination = audioContext.createMediaStreamDestination();

        for (const track of audioTracks) {
          const source = audioContext.createMediaStreamSource(
            new MediaStream([track])
          );

          source.connect(destination);
        }

        outputTracks.push(...destination.stream.getAudioTracks());
        audioContextRef.current = audioContext;
      }

      localRecordingStream = new MediaStream(outputTracks);
      recordingStreamRef.current = localRecordingStream;

      const mimeType = [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm'
      ].find((type) => MediaRecorder.isTypeSupported(type));

      if (!mimeType) {
        throw new Error('This browser does not support WebM recording.');
      }

      const recorder = new MediaRecorder(localRecordingStream, { mimeType });

      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onerror = () => {
        setMessage('Recording failed. Please try again.');
        setRecording(false);
      };

      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || 'video/webm'
        });

        // Stop the canvas drawing loop and all recording-only tracks.
        if (drawFrameRef.current !== null) {
          cancelAnimationFrame(drawFrameRef.current);
          drawFrameRef.current = null;
        }

        canvasStreamRef.current?.getTracks().forEach((track) => track.stop());
        canvasStreamRef.current = null;

        recordingStreamRef.current
          ?.getTracks()
          .forEach((track) => track.stop());
        recordingStreamRef.current = null;

        micRef.current?.getTracks().forEach((track) => track.stop());
        micRef.current = null;

        const context = audioContextRef.current;
        audioContextRef.current = null;

        if (context) {
          void context.close().catch(() => {});
        }

        setRecording(false);

        if (blob.size === 0) {
          setMessage('No video data was captured.');
          return;
        }

        const url = URL.createObjectURL(blob);
        const nextCount = countRef.current + 1;

        const item: SavedRecording = {
          id: crypto.randomUUID(),
          name: `captureflow-${nextCount}.webm`,
          url,
          createdAt: new Date().toLocaleString()
        };

        // SAVE RECORDING PERMANENTLY IN INDEXEDDB
        try {
          await saveRecordingToDB({
            id: item.id,
            name: item.name,
            blob,
            createdAt: item.createdAt
          });
        } catch (error) {
          console.error('Failed to save recording:', error);

          setMessage(
            'Recording is available temporarily, but could not be saved permanently. Check browser storage.'
          );

          // Keep the current recording available in this session.
          setRecordings((previous) => [...previous, item]);
          setActiveRecordingId(item.id);
          return;
        }

        countRef.current = nextCount;
        setCompletedCount(nextCount);
        //setRecordings((previous) => [item, ...previous]);
        setRecordings((previous) => [...previous, item]);
        setActiveRecordingId(item.id);

        setMessage(`Recording ${nextCount} is ready to preview or download.`);

        if (nextCount >= FREE_LIMIT && !emailRef.current) {
          setShowEmailModal(true);
        }
      };

      recorder.start(1000);
      setElapsed(0);
      setRecording(true);
      setMessage('Recording custom area only.');
    } catch (error) {
      if (drawFrameRef.current !== null) {
        cancelAnimationFrame(drawFrameRef.current);
        drawFrameRef.current = null;
      }

      localCanvasStream?.getTracks().forEach((track) => track.stop());
      canvasStreamRef.current = null;

      localRecordingStream?.getTracks().forEach((track) => track.stop());
      recordingStreamRef.current = null;

      micStream?.getTracks().forEach((track) => track.stop());
      micRef.current = null;

      if (audioContext) {
        await audioContext.close().catch(() => {});
        audioContextRef.current = null;
      }

      setRecording(false);

      setMessage(
        error instanceof Error ? error.message : 'Unable to start recording.'
      );
    }
  }

  const activeRecording = recordings.find(
    (item) => item.id === activeRecordingId
  );

  return (
    <main className={`app-shell theme-${theme}`}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">C</div>
          <div>
            <strong>CaptureFlow</strong>
            <span>SCREEN STUDIO</span>
          </div>
        </div>

        <div className="side-label">WORKSPACE</div>

        <button
          className={`nav-item ${!showLibrary ? 'active' : ''}`}
          onClick={() => setShowLibrary(false)}
        >
          <span>▣</span> Screen recorder
        </button>

        <button
          className={`nav-item ${showLibrary ? 'active' : ''}`}
          onClick={() => setShowLibrary(true)}
        >
          <span>▤</span> My recordings
          {recordings.length > 0 && (
            <span style={{ marginLeft: 'auto' }}>{recordings.length}</span>
          )}
        </button>

        <div className="sidebar-bottom">
          <div className="plan-card">
            <span className="plan-icon">✦</span>
            <strong>CaptureFlow Free</strong>
            <p>
              {registeredEmail
                ? 'Email registered'
                : 'Your workspace is ready.'}
            </p>
            <div className="plan-track">
              <span
                style={{
                  width: `${registeredEmail ? 100 : Math.min(100, (completedCount / FREE_LIMIT) * 100)}%`
                }}
              />
            </div>
            <small>
              {registeredEmail
                ? 'Registered workspace'
                : `${Math.min(completedCount, FREE_LIMIT)} of ${FREE_LIMIT} free recordings`}
            </small>
          </div>

          <div className="profile">
            <div className="avatar">CF</div>
            <div>
              <strong>My workspace</strong>
              <span>{registeredEmail || 'Local session'}</span>
            </div>
            <span className="more">•••</span>
          </div>
        </div>
      </aside>

      <section className="main-panel">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <span>/</span>{' '}
            {showLibrary ? 'My recordings' : 'Screen recorder'}
          </div>

          <div className="top-actions">
            <span className="secure">
              <i /> Browser capture
            </span>
            <button
              type="button"
              className="icon-button"
              title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
              aria-label={
                isDark ? 'Switch to light theme' : 'Switch to dark theme'
              }
              onClick={() =>
                setTheme((current) => (current === 'dark' ? 'light' : 'dark'))
              }
            >
              {isDark ? '☀️' : '🌙'}
            </button>
            <button
              className="icon-button"
              title="Settings"
              onClick={() => setMessage('Settings coming soon')}
            >
              ⚙
            </button>
          </div>
        </header>

        <div className="page-content">
          {showLibrary ? (
            <section className="preview-card">
              <div className="card-heading">
                <div>
                  <strong>Recording library</strong>
                  <span>{recordings.length} completed recordings</span>
                </div>
              </div>

              {recordings.length === 0 ? (
                <div className="empty-preview" style={{ minHeight: 280 }}>
                  <div className="screen-icon">▤</div>
                  <strong>No recordings yet</strong>
                  <p>Your completed recordings will appear here.</p>
                  <button
                    className="primary-button"
                    onClick={() => setShowLibrary(false)}
                  >
                    Go to recorder
                  </button>
                </div>
              ) : (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                    gap: 18,
                    padding: 20
                  }}
                >
                  {recordings.map((item) => (
                    <article
                      key={item.id}
                      style={{
                        minWidth: 0,
                        padding: 14,
                        border: '1px solid var(--border, #334155)',
                        borderRadius: 12
                      }}
                    >
                      <strong>{item.name}</strong>
                      <p style={{ fontSize: 12, opacity: 0.7 }}>
                        {item.createdAt}
                      </p>

                      <video
                        src={item.url}
                        controls
                        preload="metadata"
                        playsInline
                        style={{
                          display: 'block',
                          width: '100%',
                          margin: '12px 0',
                          borderRadius: 8,
                          background: '#000'
                        }}
                      />

                      <div
                        style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
                      >
                        <button
                          className="secondary-button"
                          onClick={() => {
                            setActiveRecordingId(item.id);
                            setShowLibrary(false);
                          }}
                        >
                          Open preview
                        </button>

                        <a
                          href={item.url}
                          download={item.name}
                          className="secondary-button"
                          style={{ textDecoration: 'none' }}
                        >
                          ↓ Download
                        </a>

                        <button
                          type="button"
                          className="secondary-button"
                          style={{ color: '#ef4444', borderColor: '#ef4444' }}
                          onClick={() => deleteRecording(item)}
                        >
                          🗑 Delete
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          ) : (
            <>
              <div className="studio-grid">
                <section className="preview-card">
                  <div className="card-heading">
                    <div>
                      <strong>Capture preview</strong>
                      <span>Drag the frame to position it</span>
                    </div>
                    <span className="live-label">
                      <i /> LIVE PREVIEW
                    </span>
                  </div>

                  <div className="preview-stage">
                    <video ref={videoRef} autoPlay muted playsInline />

                    {!sharing && (
                      <div className="empty-preview">
                        <div className="screen-icon">▣</div>
                        <strong>Your screen, in focus</strong>
                        <p>
                          Share a screen or window to see your live preview
                          here.
                        </p>
                      </div>
                    )}

                    {sharing && (
                      <div
                        className="capture-frame"
                        style={{
                          left: `${region.x}%`,
                          top: `${region.y}%`,
                          width: `${region.w}%`,
                          height: `${region.h}%`,
                          cursor: recording ? 'default' : 'move',
                          touchAction: 'none',
                          userSelect: 'none'
                        }}
                        onPointerDown={(e) => startDrag(e, 'move')}
                        onPointerMove={moveDrag}
                        onPointerUp={stopDrag}
                        onPointerCancel={stopDrag}
                        onLostPointerCapture={() => {
                          dragRef.current.mode = null;
                        }}
                      >
                        <div className="frame-label">
                          <i /> CAPTURE AREA
                        </div>

                        {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
                          <div
                            key={corner}
                            className={`resize-handle ${corner}`}
                            style={{
                              touchAction: 'none',
                              cursor: recording ? 'default' : `${corner}-resize`
                            }}
                            onPointerDown={(e) => startDrag(e, corner)}
                          />
                        ))}
                      </div>
                    )}

                    <div className="preview-footer">
                      <span>
                        <i />{' '}
                        {sharing
                          ? 'Screen preview active'
                          : 'Waiting for screen'}
                      </span>
                      <span>
                        {Math.round(region.w)}% × {Math.round(region.h)}%
                      </span>
                    </div>
                  </div>

                  <div className="preview-tools">
                    <div>
                      <span className="tool-icon">⌗</span>
                      <span>
                        <strong>Custom area</strong>
                        <small>Resizable capture frame</small>
                      </span>
                    </div>

                    <button
                      className="secondary-button"
                      disabled={recording}
                      onClick={() =>
                        updateRegion({ x: 15, y: 15, w: 65, h: 65 })
                      }
                    >
                      Reset area
                    </button>
                  </div>

                  <div style={{ padding: '0 20px 18px' }}>
                    <button
                      className="primary-button"
                      onClick={shareScreen}
                      disabled={recording}
                    >
                      ▣ {sharing ? 'Change shared screen' : 'Share screen'}
                    </button>
                  </div>
                </section>

                <aside className="settings-card">
                  {/* RECORDING COUNT CARD */}
                  <section
                    style={{
                      margin: '0 0 20px 0',
                      padding: '16px',
                      width: '100%',
                      boxSizing: 'border-box',
                      borderRadius: 18,
                      border: `1px solid ${isDark ? '#334155' : '#cbd5e1'}`,
                      background: isDark
                        ? 'linear-gradient(120deg, rgba(79,70,229,0.16), #0f172a)'
                        : 'linear-gradient(120deg, #eef2ff, #ffffff)',
                      color: isDark ? '#f8fafc' : '#0f172a',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 20,
                      flexWrap: 'wrap'
                    }}
                  >
                    <div
                      style={{ display: 'flex', alignItems: 'center', gap: 16 }}
                    >
                      <div
                        style={{
                          width: 54,
                          height: 54,
                          flexShrink: 0,
                          borderRadius: 15,
                          display: 'grid',
                          placeItems: 'center',
                          background: 'rgba(129,140,248,0.18)',
                          color: '#a5b4fc',
                          fontSize: 27
                        }}
                      >
                        ▷
                      </div>

                      <div>
                        <div
                          style={{
                            fontSize: 12,
                            letterSpacing: 1.2,
                            color: '#a5b4fc',
                            fontWeight: 700
                          }}
                        >
                          RECORDING USAGE
                        </div>

                        <div
                          style={{
                            marginTop: 5,
                            fontSize: 25,
                            fontWeight: 800,
                            color: '#f8fafc'
                          }}
                        >
                          {completedCount}
                          <span
                            style={{
                              fontSize: 15,
                              fontWeight: 500,
                              color: '#94a3b8'
                            }}
                          >
                            {' '}
                            recordings completed
                          </span>
                        </div>

                        <div
                          style={{
                            marginTop: 5,
                            fontSize: 13,
                            color: '#cbd5e1'
                          }}
                        >
                          {registeredEmail
                            ? 'Email registered · You can continue recording'
                            : `${Math.max(0, FREE_LIMIT - Math.min(completedCount, FREE_LIMIT))} free recordings remaining`}
                        </div>
                      </div>
                    </div>

                    <div style={{ minWidth: 180, flex: '0 1 220px' }}>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          gap: 10,
                          marginBottom: 9,
                          fontSize: 12,
                          color: '#cbd5e1'
                        }}
                      >
                        <span>
                          {registeredEmail
                            ? 'Registration status'
                            : 'Free plan'}
                        </span>
                        <strong style={{ color: '#f8fafc' }}>
                          {registeredEmail
                            ? 'Registered'
                            : `${Math.min(completedCount, FREE_LIMIT)}/${FREE_LIMIT}`}
                        </strong>
                      </div>

                      <div
                        style={{
                          height: 9,
                          borderRadius: 99,
                          overflow: 'hidden',
                          background: '#334155'
                        }}
                      >
                        <div
                          style={{
                            width: `${
                              registeredEmail
                                ? 100
                                : Math.min(
                                    100,
                                    (completedCount / FREE_LIMIT) * 100
                                  )
                            }%`,
                            height: '100%',
                            borderRadius: 99,
                            background: registeredEmail
                              ? '#34d399'
                              : completedCount >= FREE_LIMIT
                                ? '#fb7185'
                                : 'linear-gradient(90deg, #818cf8, #c084fc)',
                            transition: 'width 300ms ease'
                          }}
                        />
                      </div>

                      <div
                        style={{
                          marginTop: 8,
                          fontSize: 11,
                          color: '#94a3b8',
                          textAlign: 'right'
                        }}
                      >
                        {registeredEmail
                          ? 'Registration saved locally'
                          : completedCount >= FREE_LIMIT
                            ? 'Email registration required'
                            : 'Your recordings stay in your library'}
                      </div>
                    </div>
                  </section>
                  <div className="settings-heading">
                    <strong>Recording settings</strong>
                    <span>Configure your capture</span>
                  </div>

                  <div className="setting-section">
                    <div className="section-title">
                      <span className="setting-icon">▣</span> SCREEN SOURCE
                    </div>

                    <div className="source-box">
                      <div className="source-symbol">▧</div>
                      <div className="source-copy">
                        <strong>
                          {sharing ? 'Screen shared' : 'Entire screen / window'}
                        </strong>
                        <span>
                          {sharing
                            ? 'Live browser capture'
                            : 'Select a source to begin'}
                        </span>
                      </div>
                      <button
                        className="small-button"
                        onClick={shareScreen}
                        disabled={recording}
                      >
                        {sharing ? 'Change' : 'Select'}
                      </button>
                    </div>
                  </div>

                  <div className="setting-section">
                    <div className="section-title">
                      <span className="setting-icon">♫</span> AUDIO INPUTS
                    </div>

                    <div className="toggle-row">
                      <div className="audio-symbol mic">♩</div>
                      <div className="toggle-copy">
                        <strong>Microphone</strong>
                        <span>Your voice</span>
                      </div>
                      <button
                        className={`toggle ${micEnabled ? 'on' : ''}`}
                        aria-label="Toggle microphone"
                        aria-pressed={micEnabled}
                        disabled={recording}
                        onClick={() => setMicEnabled((v) => !v)}
                      >
                        <i />
                      </button>
                    </div>

                    <div className="toggle-row">
                      <div className="audio-symbol system">▤</div>
                      <div className="toggle-copy">
                        <strong>System audio</strong>
                        <span>Sound from shared source</span>
                      </div>
                      <button
                        className={`toggle ${systemAudio ? 'on' : ''}`}
                        aria-label="Toggle system audio"
                        aria-pressed={systemAudio}
                        disabled={recording}
                        onClick={() => setSystemAudio((v) => !v)}
                      >
                        <i />
                      </button>
                    </div>

                    <p className="audio-note">
                      System audio availability depends on the browser and the
                      shared source.
                    </p>
                  </div>

                  <div className="setting-section quality-section">
                    <div className="section-title">
                      <span className="setting-icon">◇</span> OUTPUT QUALITY
                    </div>
                    <div className="quality-row">
                      <span>Frame rate</span>
                      <strong>Up to 30 FPS</strong>
                    </div>
                    <div className="quality-row">
                      <span>Format</span>
                      <strong>WebM · Browser</strong>
                    </div>
                  </div>

                  <div className="record-controls">
                    <div className="timer-row">
                      <span>SESSION TIMER</span>
                      <strong>{time}</strong>
                    </div>
                    <button
                      className="record-button"
                      onClick={toggleRecording}
                      disabled={
                        !sharing && !navigator.mediaDevices?.getDisplayMedia
                      }
                    >
                      <span className="record-dot" />
                      {recording ? 'Stop recording' : 'Start recording'}
                    </button>
                    <div className="control-footnote">
                      {recording
                        ? 'Click to stop and save to your library.'
                        : 'Recordings are not downloaded automatically.'}
                    </div>
                  </div>
                </aside>
              </div>

              {activeRecording && (
                <section
                  className="preview-card"
                  style={{ marginTop: 24, padding: 20 }}
                >
                  <div className="card-heading">
                    <div>
                      <strong>Latest recording preview</strong>
                      <span>{activeRecording.name}</span>
                    </div>
                    <button
                      className="secondary-button"
                      onClick={() => setShowLibrary(true)}
                    >
                      All recordings
                    </button>
                  </div>

                  <video
                    src={activeRecording.url}
                    controls
                    playsInline
                    preload="metadata"
                    style={{
                      width: '100%',
                      maxHeight: 480,
                      background: '#000',
                      borderRadius: 10,
                      marginTop: 16
                    }}
                  />

                  <div
                    style={{
                      marginTop: 14,
                      display: 'flex',
                      gap: 10,
                      flexWrap: 'wrap'
                    }}
                  >
                    <a
                      className="primary-button"
                      href={activeRecording.url}
                      download={activeRecording.name}
                      style={{ textDecoration: 'none' }}
                    >
                      ↓ Download recording
                    </a>

                    <button
                      type="button"
                      className="secondary-button"
                      style={{ color: '#ef4444', borderColor: '#ef4444' }}
                      onClick={() => deleteRecording(activeRecording)}
                    >
                      🗑 Delete recording
                    </button>
                  </div>
                </section>
              )}

              {/* SAVED RECORDINGS GALLERY — keeps older recordings visible */}
              {recordings.length > 0 && (
                <section
                  className="preview-card"
                  style={{ marginTop: 24, padding: 20 }}
                >
                  <div className="card-heading">
                    <div>
                      <strong>Your recordings</strong>
                      <span>
                        {recordings.length} saved recording
                        {recordings.length === 1 ? '' : 's'}
                      </span>
                    </div>

                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => setShowLibrary(true)}
                    >
                      View all
                    </button>
                  </div>

                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns:
                        'repeat(auto-fill, minmax(220px, 1fr))',
                      gap: 16,
                      marginTop: 20
                    }}
                  >
                    {[...recordings].reverse().map((item) => (
                      <article
                        key={item.id}
                        style={{
                          minWidth: 0,
                          padding: 12,
                          border: '1px solid var(--border, #334155)',
                          borderRadius: 12
                        }}
                      >
                        <video
                          src={item.url}
                          controls
                          preload="metadata"
                          playsInline
                          style={{
                            display: 'block',
                            width: '100%',
                            aspectRatio: '16 / 9',
                            objectFit: 'contain',
                            background: '#000',
                            borderRadius: 8
                          }}
                        />

                        <strong
                          style={{
                            display: 'block',
                            marginTop: 12,
                            overflowWrap: 'anywhere'
                          }}
                        >
                          {item.name}
                        </strong>

                        <p style={{ fontSize: 12, opacity: 0.7 }}>
                          {item.createdAt}
                        </p>

                        <div
                          style={{
                            display: 'flex',
                            gap: 8,
                            flexWrap: 'wrap'
                          }}
                        >
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() => {
                              setActiveRecordingId(item.id);
                              setShowLibrary(false);
                              window.scrollTo({
                                top: document.body.scrollHeight,
                                behavior: 'smooth'
                              });
                            }}
                          >
                            Open preview
                          </button>

                          <a
                            href={item.url}
                            download={item.name}
                            className="secondary-button"
                            style={{ textDecoration: 'none' }}
                          >
                            Download
                          </a>

                          <button
                            type="button"
                            className="secondary-button"
                            style={{
                              color: '#ef4444',
                              borderColor: '#ef4444'
                            }}
                            onClick={() => deleteRecording(item)}
                          >
                            Delete
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}

          <div className="bottom-notice">
            <span className="notice-icon">i</span>
            <div>
              <strong>{message}</strong>
              <span>
                Recordings remain available in this page until it is refreshed
                or closed. Download any video you want to keep.
              </span>
            </div>
          </div>
        </div>
      </section>

      {showEmailModal && !registeredEmail && (
        <div
          role="presentation"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
            background: 'rgba(2, 6, 23, 0.78)',
            backdropFilter: 'blur(5px)'
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="email-dialog-title"
            style={{
              width: '100%',
              maxWidth: 440,
              padding: 28,
              borderRadius: 20,
              color: '#f8fafc',
              background: '#111827',
              border: '1px solid #334155',
              boxShadow: '0 25px 80px rgba(0,0,0,.45)'
            }}
          >
            <div style={{ fontSize: 30, marginBottom: 12 }}>✉</div>
            <h2
              id="email-dialog-title"
              style={{ fontSize: 24, fontWeight: 700, margin: 0 }}
            >
              Continue with CaptureFlow
            </h2>
            <p style={{ color: '#cbd5e1', lineHeight: 1.6, marginTop: 12 }}>
              You have completed five recordings. Enter your email address to
              unlock additional recordings.
            </p>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                registerEmail();
              }}
              style={{ marginTop: 22 }}
            >
              <label
                htmlFor="captureflow-email"
                style={{
                  display: 'block',
                  marginBottom: 8,
                  fontSize: 14,
                  fontWeight: 600
                }}
              >
                Email address
              </label>

              <input
                id="captureflow-email"
                type="email"
                required
                autoComplete="email"
                autoFocus
                value={emailInput}
                onChange={(e) => {
                  setEmailInput(e.target.value);
                  setEmailError('');
                }}
                placeholder="you@example.com"
                style={{
                  boxSizing: 'border-box',
                  width: '100%',
                  padding: '13px 14px',
                  borderRadius: 10,
                  color: '#f8fafc',
                  background: '#020617',
                  border: '1px solid #475569',
                  outlineOffset: 2
                }}
              />

              {emailError && (
                <p role="alert" style={{ color: '#fca5a5', fontSize: 13 }}>
                  {emailError}
                </p>
              )}

              <button
                type="submit"
                className="primary-button"
                style={{
                  width: '100%',
                  marginTop: 14,
                  justifyContent: 'center'
                }}
              >
                Register email &amp; continue
              </button>
            </form>

            <p
              style={{
                color: '#94a3b8',
                fontSize: 12,
                lineHeight: 1.6,
                marginTop: 16
              }}
            >
              Prototype registration: your email is stored in this browser only.
              It is not verified or sent to a server.
            </p>
          </section>
        </div>
      )}
    </main>
  );
}
