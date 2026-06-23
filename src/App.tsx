import { useState, useEffect, useRef } from "react";
import { 
  MicOff, 
  Wifi, 
  WifiOff, 
  Plane, 
  Play, 
  Trash2, 
  Key, 
  Terminal, 
  User, 
  Bot, 
  Activity,
  RefreshCw
} from "lucide-react";
import { AudioRecorder } from "./lib/audio-recorder";
import { AudioStreamer } from "./lib/audio-streamer";
import { GeminiLiveClient } from "./lib/gemini-live-client";
import type { Flight, ObservabilityLog } from "./lib/gemini-live-client";
import VolMeterWorket from "./lib/worklets/vol-meter";

interface TranscriptTurn {
  id: string;
  role: "user" | "agent";
  text: string;
  timestamp: string;
}

export default function App() {
  // Config & Status States
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("gemini_live_apikey") || "");
  const [model, setModel] = useState(() => localStorage.getItem("gemini_live_model") || "models/gemini-3.1-flash-live-preview");
  const [apiVersion, setApiVersion] = useState(() => localStorage.getItem("gemini_live_apiversion") || "v1beta");
  const [availableModels, setAvailableModels] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem("gemini_live_available_models");
      return saved ? JSON.parse(saved) : ["models/gemini-3.1-flash-live-preview"];
    } catch {
      return ["models/gemini-3.1-flash-live-preview"];
    }
  });
  const [detectingModels, setDetectingModels] = useState(false);
  const [status, setStatus] = useState<"disconnected" | "connecting" | "connected" | "listening" | "speaking">("disconnected");
  const [showKeyInput, setShowKeyInput] = useState(!apiKey);
  const [textInput, setTextInput] = useState("");

  // Observability Metrics
  const [latency, setLatency] = useState<number | null>(null);
  const [avgLatency, setAvgLatency] = useState<number>(0);
  const [latencyCount, setLatencyCount] = useState<number>(0);
  const [guardrailHits, setGuardrailHits] = useState<number>(0);
  const [packetsSent, setPacketsSent] = useState<number>(0);
  const [packetsReceived, setPacketsReceived] = useState<number>(0);
  
  // Audio VU Level States (0.0 to 1.0)
  const [userVolume, setUserVolume] = useState<number>(0);
  const [agentVolume, setAgentVolume] = useState<number>(0);

  // Data Lists
  const [transcripts, setTranscripts] = useState<TranscriptTurn[]>([]);
  const [logs, setLogs] = useState<ObservabilityLog[]>([]);
  const [flights, setFlights] = useState<Flight[]>([]);

  // Refs for audio instances & state synchronization
  const clientRef = useRef<GeminiLiveClient | null>(null);
  const recorderRef = useRef<AudioRecorder | null>(null);
  const streamerRef = useRef<AudioStreamer | null>(null);
  
  const transcriptAreaRef = useRef<HTMLDivElement>(null);
  const logsAreaRef = useRef<HTMLDivElement>(null);

  // Save Configuration
  const handleSaveConfig = (key: string, selectedModel: string, selectedVersion: string) => {
    setApiKey(key);
    setModel(selectedModel);
    setApiVersion(selectedVersion);
    localStorage.setItem("gemini_live_apikey", key);
    localStorage.setItem("gemini_live_model", selectedModel);
    localStorage.setItem("gemini_live_apiversion", selectedVersion);
    setShowKeyInput(false);
    addLocalLog("success", `Configuration updated: Model=${selectedModel}, API Version=${selectedVersion}`);
  };

  // Detect Live Models from Google AI Studio
  const detectLiveModels = async (keyToUse: string) => {
    if (!keyToUse) {
      alert("Please enter your API Key first.");
      return;
    }
    setDetectingModels(true);
    addLocalLog("info", "Querying Google AI Studio for supported Live API models...");
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${keyToUse}`);
      if (!res.ok) {
        throw new Error(`HTTP Error ${res.status}: ${res.statusText}`);
      }
      const data = await res.json();
      if (data.models && Array.isArray(data.models)) {
        const liveModels = data.models
          .filter((m: any) => {
            const methods = m.supportedGenerationMethods || m.supportedMethods || [];
            const hasBidi = methods.some((method: string) => 
              method.toLowerCase() === "bidigeneratecontent"
            );
            const isLiveName = m.name?.toLowerCase().includes("live") || m.name?.toLowerCase().includes("realtime");
            return hasBidi || isLiveName;
          })
          .map((m: any) => m.name);
        
        if (liveModels.length > 0) {
          setAvailableModels(liveModels);
          localStorage.setItem("gemini_live_available_models", JSON.stringify(liveModels));
          setModel(liveModels[0]);
          addLocalLog("success", `Detected ${liveModels.length} Live-capable models:`, liveModels);
          alert(`Detected ${liveModels.length} Live models! They have been added to the selection dropdown.`);
        } else {
          const allModelNames = data.models.map((m: any) => m.name);
          addLocalLog("warning", "No models with explicit 'bidiGenerateContent' support were returned. Available models on your key:", allModelNames);
          alert("No Live-capable models were detected on your key. You can still type a custom model string.");
        }
      }
    } catch (err: any) {
      addLocalLog("error", "Failed to detect models", err.message);
      alert("Failed to query models list. Please check your API key and internet connection.");
    } finally {
      setDetectingModels(false);
    }
  };

  const addLocalLog = (type: ObservabilityLog["type"], message: string, details?: any) => {
    const newLog: ObservabilityLog = {
      id: Math.random().toString(36).substring(2, 9),
      timestamp: new Date().toLocaleTimeString(),
      type,
      message,
      details
    };
    setLogs(prev => [...prev, newLog]);
  };

  // Connect / Disconnect Handler
  const toggleSession = async () => {
    if (status !== "disconnected") {
      cleanupSession();
      return;
    }

    if (!apiKey) {
      alert("Please enter a valid Gemini API Key first.");
      setShowKeyInput(true);
      return;
    }

    setStatus("connecting");
    setFlights([]);
    setLatency(null);

    try {
      // 1. Initialize Audio Streamer (Playback)
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const context = new AudioCtx({ sampleRate: 24000 });
      const streamer = new AudioStreamer(context);
      
      // Wire volume meter to streamer to visualize agent's voice
      await streamer.addWorklet("vu-meter", VolMeterWorket, (ev: any) => {
        if (ev.data.volume !== undefined) {
          setAgentVolume(ev.data.volume);
        }
      });
      await streamer.resume();
      streamerRef.current = streamer;

      // 2. Initialize Audio Recorder (Input)
      const recorder = new AudioRecorder(16000);
      recorderRef.current = recorder;

      // 3. Initialize Gemini Live Client
      const client = new GeminiLiveClient(apiKey, model, apiVersion);
      clientRef.current = client;

      // Bind WebSocket Events
      client.on("open", () => {
        setStatus("connected");
        addLocalLog("success", "Gemini Live Session Started. Microphone active.");
        
        // Start recording immediately after setup complete
        startRecording();
        
        // Auto-greet: Send a light prompt to warm up the assistant and request a greeting
        // E.g., The model will greet the user because it receives an initial turn.
        addLocalLog("info", "Sending auto-greeting trigger...");
        client.sendTextPrompt("Hi");
      });

      client.on("close", () => {
        cleanupSession();
      });

      client.on("error", (err) => {
        addLocalLog("error", "Gemini Client Error", err);
        cleanupSession();
      });

      client.on("audio", (rawAudioChunk: Uint8Array) => {
        setPacketsReceived(prev => prev + 1);
        if (streamerRef.current) {
          streamerRef.current.addPCM16(rawAudioChunk);
          setStatus("speaking");
        }
      });

      // When the model gets interrupted, immediately halt playback
      client.on("interrupted", () => {
        if (streamerRef.current) {
          streamerRef.current.stop();
        }
        setStatus("listening");
        setAgentVolume(0);
      });

      // Handle user transcripts (what the user said)
      client.on("userTranscript", (text: string) => {
        if (!text.trim()) return;
        setTranscripts(prev => {
          // If the last turn was also user, merge it, otherwise create new
          const last = prev[prev.length - 1];
          if (last && last.role === "user") {
            return [...prev.slice(0, -1), { ...last, text: last.text + " " + text }];
          }
          return [...prev, {
            id: Math.random().toString(),
            role: "user",
            text,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          }];
        });
      });

      // Handle assistant transcripts (what the agent is speaking)
      client.on("agentTranscript", (text: string) => {
        if (!text.trim()) return;
        setTranscripts(prev => {
          const last = prev[prev.length - 1];
          if (last && last.role === "agent") {
            // Append streaming text
            return [...prev.slice(0, -1), { ...last, text: last.text + text }];
          }
          return [...prev, {
            id: Math.random().toString(),
            role: "agent",
            text,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          }];
        });
      });

      client.on("flightsResult", (flightList: Flight[]) => {
        setFlights(flightList);
      });

      client.on("guardrailTrigger", () => {
        setGuardrailHits(prev => prev + 1);
      });

      client.on("latency", (latMs: number) => {
        setLatency(latMs);
        setLatencyCount(prev => {
          const newCount = prev + 1;
          setAvgLatency(prevAvg => Math.round((prevAvg * prev + latMs) / newCount));
          return newCount;
        });
      });

      client.on("log", (logItem: ObservabilityLog) => {
        setLogs(prev => [...prev, logItem]);
      });

      // Trigger Connection
      client.connect();

    } catch (err: any) {
      addLocalLog("error", "Session connection failed", err.message);
      cleanupSession();
    }
  };

  // Start Mic Recording & Pipe Audio Chunks to Client
  const startRecording = async () => {
    if (!recorderRef.current || !clientRef.current) return;

    try {
      recorderRef.current.on("data", (base64Audio: string) => {
        setPacketsSent(prev => prev + 1);
        if (clientRef.current) {
          clientRef.current.sendAudioChunk(base64Audio);
        }
      });

      recorderRef.current.on("volume", (vol: number) => {
        setUserVolume(vol);
      });

      await recorderRef.current.start();
      setStatus("listening");
    } catch (err: any) {
      addLocalLog("error", "Microphone access denied or failed", err.message);
      cleanupSession();
    }
  };

  // Disconnect, Stop Recording, and Clear Buffers
  const cleanupSession = () => {
    setStatus("disconnected");
    setUserVolume(0);
    setAgentVolume(0);

    if (recorderRef.current) {
      recorderRef.current.stop();
      recorderRef.current = null;
    }

    if (streamerRef.current) {
      streamerRef.current.stop();
      streamerRef.current = null;
    }

    if (clientRef.current) {
      clientRef.current.disconnect();
      clientRef.current = null;
    }

    addLocalLog("warning", "Voice agent session disconnected.");
  };

  // Clean up on component unmount
  useEffect(() => {
    return () => cleanupSession();
  }, []);

  // Set status based on active audio playback
  useEffect(() => {
    if (status === "speaking" && agentVolume === 0) {
      // Small timeout to prevent flickering between speaking and listening
      const timer = setTimeout(() => {
        if (status === "speaking") {
          setStatus("listening");
        }
      }, 800);
      return () => clearTimeout(timer);
    }
  }, [agentVolume, status]);

  // Handle Text Fallback Input
  const handleSendText = (e: React.FormEvent) => {
    e.preventDefault();
    if (!textInput.trim() || !clientRef.current || status === "disconnected") return;

    const userText = textInput.trim();
    setTextInput("");

    // Append user text transcript locally since Gemini inputTranscription is voice-only
    setTranscripts(prev => [...prev, {
      id: Math.random().toString(),
      role: "user",
      text: userText,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }]);

    clientRef.current.sendTextPrompt(userText);
    setStatus("speaking"); // Model will speak back the text response
  };

  // Auto-scroll scrollable panels
  useEffect(() => {
    if (transcriptAreaRef.current) {
      transcriptAreaRef.current.scrollTop = transcriptAreaRef.current.scrollHeight;
    }
  }, [transcripts]);

  useEffect(() => {
    if (logsAreaRef.current) {
      logsAreaRef.current.scrollTop = logsAreaRef.current.scrollHeight;
    }
  }, [logs]);

  // Clear Chat Logs
  const clearChat = () => {
    setTranscripts([]);
    setFlights([]);
  };

  // Generate Waveform Bars
  const renderWaveform = () => {
    const barsCount = 28;
    const bars = [];
    const isActive = status === "listening" || status === "speaking";
    
    // Choose active stream volume
    const volume = status === "speaking" ? agentVolume : userVolume;
    const isUser = status !== "speaking";

    for (let i = 0; i < barsCount; i++) {
      // Generate bell curve shape
      const mid = barsCount / 2;
      const distFromMid = Math.abs(i - mid);
      const factor = Math.max(0.1, 1 - distFromMid / mid);
      
      // Calculate individual height based on current real-time volume
      let height = 6;
      if (isActive && volume > 0.01) {
        // Add a bit of random jitter for fluid organic motion
        const jitter = 0.85 + Math.random() * 0.3;
        height = Math.max(6, Math.round(volume * 140 * factor * jitter));
      }

      bars.push(
        <div 
          key={i}
          className={`wave-bar ${!isActive ? "idle" : isUser ? "user" : "agent"}`}
          style={{ height: `${height}px` }}
        />
      );
    }
    return bars;
  };

  return (
    <div className="flex flex-col min-h-screen">
      {/* Header bar */}
      <header className="header">
        <div className="logo-section">
          <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-blue-600 shadow-lg shadow-blue-500/30">
            <Plane className="w-5 h-5 text-white" />
          </div>
          <h1>AeirTrip Voice Agent</h1>
        </div>

        <div className="flex items-center gap-4">
          {/* API Key Panel Toggle */}
          <button 
            className="flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-sm bg-gray-800 hover:bg-gray-700 border border-gray-700 transition"
            onClick={() => setShowKeyInput(!showKeyInput)}
          >
            <Key className="w-4 h-4 text-blue-400" />
            <span>API Key Setup</span>
          </button>

          {/* Quick status badge */}
          <div className="flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-sm bg-gray-800 border border-gray-700">
            {status !== "disconnected" ? (
              <span className="flex items-center gap-1.5 text-emerald-400">
                <Wifi className="w-4 h-4" /> Live
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-gray-400">
                <WifiOff className="w-4 h-4" /> Offline
              </span>
            )}
          </div>
        </div>
      </header>

      {/* Main app grid */}
      <main className="app-container">
        {/* Left Side: Voice Stage, Transcripts, Flight display */}
        <div className="workspace">
          
          {/* API Key Config Panel */}
          {showKeyInput && (
            <div className="setup-panel">
              <div className="setup-header">
                <h3 className="setup-title">
                  <Key className="w-5 h-5 text-blue-400" /> API Session Setup
                </h3>
                <p className="setup-desc">
                  Configure your Gemini API key, model ID, and API version. These configurations are stored securely in your browser's local storage.
                </p>
              </div>

              <div className="setup-form">
                <div className="form-row-layout">
                  <div className="form-group">
                    <label className="form-label" htmlFor="api-key-textbox">Gemini API Key</label>
                    <input 
                      type="password"
                      placeholder="Paste your Gemini API key (AIzaSy...)" 
                      defaultValue={apiKey}
                      id="api-key-textbox"
                      className="form-control"
                    />
                  </div>
                  <button
                    type="button"
                    disabled={detectingModels}
                    onClick={() => {
                      const keyInput = document.getElementById("api-key-textbox") as HTMLInputElement;
                      detectLiveModels(keyInput.value);
                    }}
                    className="btn-detect"
                    title="Detect available live models on your key"
                  >
                    {detectingModels ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Activity className="w-4 h-4" />}
                    <span>Detect Models</span>
                  </button>
                </div>

                <div className="form-grid-layout">
                  <div className="form-group">
                    <label className="form-label" htmlFor="model-select">Detected Live Models</label>
                    <select 
                      id="model-select"
                      value={availableModels.includes(model) ? model : ""}
                      onChange={(e) => {
                        if (e.target.value) {
                          setModel(e.target.value);
                        }
                      }}
                      className="form-control"
                    >
                      {availableModels.map(m => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                      <option value="">Custom (type below)...</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="version-select">API Version</label>
                    <select 
                      id="version-select"
                      defaultValue={apiVersion}
                      className="form-control"
                    >
                      <option value="v1beta">v1beta (Recommended)</option>
                      <option value="v1alpha">v1alpha</option>
                    </select>
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="model-textbox">Active Model ID</label>
                  <input 
                    type="text"
                    value={model}
                    id="model-textbox"
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="Enter custom model ID (e.g. models/gemini-2.5-flash-live)"
                    className="form-control"
                  />
                </div>

                <button
                  className="btn-save"
                  onClick={() => {
                    const keyInput = document.getElementById("api-key-textbox") as HTMLInputElement;
                    const modelInput = document.getElementById("model-textbox") as HTMLInputElement;
                    const versionSelect = document.getElementById("version-select") as HTMLSelectElement;
                    handleSaveConfig(keyInput.value, modelInput.value, versionSelect.value);
                  }}
                >
                  <span>Save Configuration</span>
                </button>
              </div>
            </div>
          )}

          {/* Active Voice Agent Stage */}
          <div className="glass-panel agent-stage">
            <div className="status-indicator">
              <span className={`status-dot ${status}`} />
              <span className="text-sm uppercase tracking-wider font-semibold">
                {status === "disconnected" && "Agent Offline"}
                {status === "connecting" && "Establishing Live Connection..."}
                {status === "connected" && "Session Connected"}
                {status === "listening" && "Listening..."}
                {status === "speaking" && "AeirTrip is speaking"}
              </span>
            </div>

            {/* Glowing wave animation */}
            <div className="wave-container">
              {renderWaveform()}
            </div>

            {/* Big Mic control button */}
            <div className={`mic-button-wrapper ${status !== "disconnected" ? "active" : ""}`}>
              <div className="mic-glow-ring" />
              <button 
                className={`mic-button ${status === "listening" ? "recording" : ""}`}
                onClick={toggleSession}
                title={status === "disconnected" ? "Connect & Start Session" : "Disconnect"}
              >
                {status === "disconnected" ? (
                  <Play className="w-7 h-7 fill-white" />
                ) : (
                  <MicOff className="w-7 h-7" />
                )}
              </button>
            </div>

            <p className="text-xs text-secondary mt-6 max-w-md">
              {status === "disconnected" && "Click the play button to start your voice travel session. Grant microphone permissions when prompted."}
              {status === "connected" && "Connecting voice loop... Make sure your microphone is connected."}
              {status === "listening" && "Speak now! Say 'Hi' to trigger the greeting flow or ask about flight searches."}
              {status === "speaking" && "The agent is responding. You can interrupt/speak over the agent at any point."}
            </p>
          </div>

          {/* Visual Flight Results Section */}
          {flights.length > 0 && (
            <div className="glass-panel flights-panel">
              <h3 className="font-bold text-sm text-primary flex items-center gap-2">
                <Plane className="w-4 h-4 text-purple-400" /> Real-time Flight Search Results
              </h3>
              <div className="flights-grid">
                {flights.map((flight, idx) => (
                  <div key={idx} className="flight-card">
                    <div className="flight-header">
                      <span className="airline-name text-white">{flight.airline}</span>
                      <span className="flight-number">{flight.flightNumber}</span>
                    </div>
                    <div className="flight-route">
                      <span>{flight.departure}</span>
                      <div className="route-dot" />
                      <span>{flight.destination}</span>
                    </div>
                    <div className="flight-times">
                      <span>Dep: {flight.departureTime}</span>
                      <span>Arr: {flight.arrivalTime}</span>
                    </div>
                    <div className="flight-footer">
                      <span className="flight-duration">{flight.duration}</span>
                      <span className="flight-price">{flight.price}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Transcript Panel */}
          <div className="glass-panel transcript-panel">
            <div className="panel-header">
              <span>Voice Turn Transcript</span>
              {transcripts.length > 0 && (
                <button 
                  onClick={clearChat}
                  className="text-xs text-secondary flex items-center gap-1.5 hover:text-red-400 transition"
                  title="Clear history"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Clear
                </button>
              )}
            </div>
            
            <div className="transcript-area" ref={transcriptAreaRef}>
              {transcripts.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-center p-6 text-muted">
                  <Bot className="w-10 h-10 mb-2 opacity-30" />
                  <p className="text-sm">No spoken logs yet.</p>
                  <p className="text-xs mt-1">Start the session and speak into your microphone to populate this view.</p>
                </div>
              ) : (
                transcripts.map((t) => (
                  <div key={t.id} className={`chat-bubble ${t.role}`}>
                    <div className="chat-avatar">
                      {t.role === "user" ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
                    </div>
                    <div className="flex flex-col gap-1">
                      <div className="chat-content text-white">
                        {t.text}
                      </div>
                      <span className="text-[10px] text-secondary self-start px-1">{t.timestamp}</span>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Optional Text Fallback Input Bar */}
            {status !== "disconnected" && (
              <form onSubmit={handleSendText} className="flex gap-2 p-3 border-t border-gray-800 bg-black/20">
                <input 
                  type="text" 
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                  placeholder="Type a message fallback here (e.g. 'Hi' or off-topic queries)..."
                  className="flex-1 bg-black/40 border border-gray-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500"
                />
                <button 
                  type="submit" 
                  className="bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded-lg text-sm font-semibold transition"
                >
                  Send
                </button>
              </form>
            )}
          </div>
        </div>

        {/* Right Side: Observability and Guardrails Logging */}
        <div className="sidebar">
          
          {/* Real-time Metrics */}
          <div className="glass-panel">
            <div className="panel-header">
              <span className="flex items-center gap-1.5"><Activity className="w-4 h-4 text-emerald-400" /> Observability Metrics</span>
            </div>
            <div className="metrics-grid">
              <div className="metric-card">
                <span className="metric-label">Avg. Latency (TTFB)</span>
                <span className="metric-value">
                  {avgLatency > 0 ? `${avgLatency}ms` : "--"}
                  {latency !== null && (
                    <span className="text-[10px] text-gray-400 block font-normal mt-0.5">
                      Last: {latency}ms
                    </span>
                  )}
                </span>
              </div>
              <div className="metric-card">
                <span className="metric-label">Guardrail Refusals</span>
                <span className={`metric-value ${guardrailHits > 0 ? "guardrail" : "success"}`}>
                  {guardrailHits}
                </span>
              </div>
              <div className="metric-card">
                <span className="metric-label">Spoken Turns</span>
                <span className="metric-value">{latencyCount}</span>
              </div>
              <div className="metric-card">
                <span className="metric-label">Audio Packets (S / R)</span>
                <span className="metric-value text-sm mt-0.5">
                  {packetsSent} / {packetsReceived}
                </span>
              </div>
            </div>
          </div>

          {/* Real-time WebSocket Logs */}
          <div className="glass-panel logs-panel">
            <div className="panel-header flex items-center justify-between">
              <span className="flex items-center gap-1.5"><Terminal className="w-4 h-4 text-purple-400" /> Guardrail & API Stream Logs</span>
              {logs.length > 0 && (
                <button 
                  onClick={() => setLogs([])}
                  className="text-xs text-secondary hover:text-red-400 transition"
                >
                  Clear Logs
                </button>
              )}
            </div>
            <div className="logs-area" ref={logsAreaRef}>
              {logs.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-center p-6 text-muted">
                  <Terminal className="w-8 h-8 mb-2 opacity-30" />
                  <p className="text-xs">Logs are empty. Open the voice loop to stream event details.</p>
                </div>
              ) : (
                logs.map((log) => (
                  <div key={log.id} className={`log-item ${log.type}`}>
                    <div className="log-header-line">
                      <span className="log-tag">{log.type}</span>
                      <span className="log-time">{log.timestamp}</span>
                    </div>
                    <span className="log-msg">{log.message}</span>
                    {log.details && (
                      <pre className="log-details">
                        {JSON.stringify(log.details, null, 2)}
                      </pre>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
