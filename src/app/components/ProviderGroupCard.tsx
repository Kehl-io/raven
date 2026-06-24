import { useCallback, useEffect, useRef, useState } from "react";
import type { ProviderGroup } from "../../domain/format";
import type { AgentAuthProfile, OllamaModel } from "../../domain/types";
import { checkOllamaStatus, listOllamaModels } from "../tauriBridge";

interface ProviderGroupCardProps {
  group: ProviderGroup;
  onConfigureKey?: (profileId: string, apiKey: string) => void;
  onOllamaReadinessChange?: (
    profileId: string,
    readiness: { isReady: boolean; resolved: boolean },
  ) => void;
}

function authModeLabel(authMode: AgentAuthProfile["authMode"]): string {
  switch (authMode) {
    case "codex_oauth_local_cli":
    case "claude_code_oauth_local_cli":
      return "OAuth";
    case "api_key_env":
    case "api_key_keychain":
      return "API Key";
    case "none":
      return "Local";
  }
}

function isUnconfigured(profile: AgentAuthProfile): boolean {
  return profile.status === "needs_config" || profile.status === "unavailable";
}

function providerStatusLabel(status: AgentAuthProfile["status"]): string {
  switch (status) {
    case "available":
      return "Ready";
    case "degraded":
      return "Degraded";
    case "unavailable":
      return "Unavailable";
    case "needs_config":
      return "Not configured";
  }
}

function setupActionLabel(profile: AgentAuthProfile): string {
  if (profile.runnerKind === "ollama_local") return "Detect Ollama";
  if (profile.authMode === "api_key_env" || profile.authMode === "api_key_keychain") {
    return `Set up ${profile.displayName}`;
  }
  return `Review ${profile.displayName}`;
}

export function ProviderGroupCard({ group, onConfigureKey, onOllamaReadinessChange }: ProviderGroupCardProps) {
  const [expandedProfileId, setExpandedProfileId] = useState<string | null>(() => {
    if (!group.isReady) {
      const first = group.profiles.find(isUnconfigured);
      return first?.id ?? null;
    }
    return null;
  });
  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({});
  const [ollamaVersion, setOllamaVersion] = useState<string | null>(null);
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([]);
  const [ollamaResolved, setOllamaResolved] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const autoDetectionKeyRef = useRef<string | null>(null);
  const isMountedRef = useRef(true);
  const ollamaRequestIdRef = useRef(0);

  const isLocalAiGroup = group.profiles.some((p) => p.runnerKind === "ollama_local");
  const ollamaProfile = group.profiles.find((p) => p.runnerKind === "ollama_local");
  const localAiReady = !ollamaProfile
    ? false
    : ollamaResolved && ollamaVersion !== null;
  const groupReady = isLocalAiGroup ? localAiReady : group.isReady;

  const reportOllamaReadiness = useCallback((readiness: { isReady: boolean; resolved: boolean }) => {
    if (!ollamaProfile) return;
    onOllamaReadinessChange?.(ollamaProfile.id, readiness);
  }, [ollamaProfile, onOllamaReadinessChange]);

  const handleDetectOllama = useCallback(async () => {
    const requestId = ++ollamaRequestIdRef.current;
    setDetecting(true);
    setOllamaResolved(false);
    reportOllamaReadiness({ isReady: false, resolved: false });

    let detectedVersion: string | null = null;
    let detectedModels: OllamaModel[] = [];
    try {
      detectedVersion = await checkOllamaStatus();
      if (detectedVersion) {
        detectedModels = await listOllamaModels();
      }
    } catch {
      detectedVersion = null;
      detectedModels = [];
    }

    if (!isMountedRef.current || ollamaRequestIdRef.current !== requestId) {
      return;
    }

    setOllamaVersion(detectedVersion);
    setOllamaModels(detectedModels);
    setOllamaResolved(true);
    setDetecting(false);
    reportOllamaReadiness({ isReady: detectedVersion !== null, resolved: true });
  }, [reportOllamaReadiness]);

  useEffect(() => {
    if (!ollamaProfile) return;

    const detectionKey = `${ollamaProfile.id}:${ollamaProfile.status}`;
    if (autoDetectionKeyRef.current === detectionKey) return;
    autoDetectionKeyRef.current = detectionKey;

    void handleDetectOllama();
  }, [handleDetectOllama, ollamaProfile, reportOllamaReadiness]);

  useEffect(() => {
    if (!ollamaProfile) return;

    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      autoDetectionKeyRef.current = null;
      ollamaRequestIdRef.current += 1;
    };
  }, [ollamaProfile?.id]);

  function toggleExpand(profileId: string) {
    setExpandedProfileId((prev) => (prev === profileId ? null : profileId));
  }

  function handleSave(profileId: string) {
    const key = apiKeyInputs[profileId] ?? "";
    if (!key) return;
    onConfigureKey?.(profileId, key);
    setApiKeyInputs((prev) => ({ ...prev, [profileId]: "" }));
    setExpandedProfileId(null);
  }

  function handleSetupClick(profile: AgentAuthProfile) {
    if (profile.runnerKind === "ollama_local") {
      void handleDetectOllama();
      return;
    }
    setExpandedProfileId(profile.id);
  }

  const needsAttention = !groupReady;
  const setupProfile = group.profiles.find(isUnconfigured);

  function displayedProfile(profile: AgentAuthProfile): AgentAuthProfile {
    if (!ollamaProfile || profile.id !== ollamaProfile.id) {
      return profile;
    }

    if (!ollamaResolved) {
      return {
        ...profile,
        status: "unavailable",
        summary: "Checking whether Ollama is running.",
      };
    }

    if (ollamaVersion === null) {
      return {
        ...profile,
        status: "unavailable",
        summary: "Ollama is not running. Start Ollama to use local AI.",
      };
    }

    return {
      ...profile,
      status: "available",
      summary: "Ollama is running locally.",
    };
  }

  const primaryProfile = isLocalAiGroup && ollamaProfile
    ? (localAiReady ? displayedProfile(ollamaProfile) : undefined)
    : group.primaryProfile;

  return (
    <div className={`provider-group-card${needsAttention ? " needs-attention" : ""}`}>
      <div className="provider-group-header">
        <div>
          <h3>{group.groupName}</h3>
          <p>
            {groupReady && primaryProfile
              ? `Primary: ${primaryProfile.displayName} · ${primaryProfile.model}`
              : "No ready profile in this group."}
          </p>
        </div>
        <span className={`readiness-pill readiness-pill-${groupReady ? "ready" : "not_configured"}`}>
          {groupReady ? "Ready" : "Setup required"}
        </span>
      </div>

      {needsAttention && setupProfile && (
        <button
          type="button"
          className="provider-setup-action"
          onClick={() => handleSetupClick(setupProfile)}
        >
          {setupActionLabel(setupProfile)}
        </button>
      )}

      {isLocalAiGroup && (
        <div className="ollama-detect-section">
          <button
            type="button"
            className="profile-expand-btn"
            onClick={handleDetectOllama}
            disabled={detecting}
          >
            {detecting ? "Detecting…" : "Detect Ollama"}
          </button>
          {ollamaResolved && (
            ollamaVersion ? (
              <div className="provider-detect-result">
                <span className="provider-detect-result-ready">Ollama {ollamaVersion} detected</span>
                {ollamaModels.length > 0 && (
                  <div className="provider-model-select">
                    <label htmlFor="ollama-model-select">
                      Available models:
                    </label>
                    <select id="ollama-model-select">
                      {ollamaModels.map((m) => (
                        <option key={m.name} value={m.name}>
                          {m.name}
                          {m.parameterSize ? ` (${m.parameterSize})` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {ollamaModels.length === 0 && (
                  <div className="settings-card-detail">
                    No models found. Run <code>ollama pull llama3.1:8b</code> to add one.
                  </div>
                )}
              </div>
            ) : (
              <div className="provider-detect-result provider-detect-result-warning">
                Ollama not running.{" "}
                <a
                  href="https://ollama.com/download"
                  target="_blank"
                  rel="noreferrer"
                >
                  Install Ollama
                </a>{" "}
                and start it to use local AI.
              </div>
            )
          )}
        </div>
      )}

      <div className="provider-group-profiles">
        {group.profiles.map((profile) => {
          const liveProfile = displayedProfile(profile);
          const unconfigured = isUnconfigured(liveProfile);
          const isOptional = unconfigured && groupReady;
          const isExpanded = expandedProfileId === profile.id;
          const canExpand =
            unconfigured &&
            (liveProfile.authMode === "api_key_env" || liveProfile.authMode === "api_key_keychain");

          return (
            <div
              key={profile.id}
              className={`profile-row${isOptional ? " profile-muted" : ""}`}
            >
              <span className={`profile-dot profile-dot-${liveProfile.status}`} />
              <span className="profile-row-main">
                <span className="profile-row-title">
                  {liveProfile.displayName}
                  <span>{authModeLabel(liveProfile.authMode)}</span>
                  {isOptional && <span>Optional</span>}
                </span>
                <span className="profile-row-summary">{liveProfile.summary}</span>
              </span>
              <span className={`readiness-pill readiness-pill-${liveProfile.status}`}>
                {providerStatusLabel(liveProfile.status)}
              </span>
              {canExpand && (
                <button
                  type="button"
                  className="profile-expand-btn"
                  onClick={() => toggleExpand(profile.id)}
                  aria-expanded={isExpanded}
                >
                  Configure API key {isExpanded ? "▴" : "▾"}
                </button>
              )}

              {isExpanded && canExpand && (
                <div
                  className="profile-config-form"
                  style={{ gridColumn: "1 / -1" }}
                >
                  <input
                    type="password"
                    aria-label={`${profile.displayName} API key`}
                    placeholder="Paste API key…"
                    value={apiKeyInputs[profile.id] ?? ""}
                    onChange={(e) =>
                      setApiKeyInputs((prev) => ({
                        ...prev,
                        [profile.id]: e.target.value,
                      }))
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleSave(profile.id);
                    }}
                  />
                  <button type="button" onClick={() => handleSave(profile.id)}>
                    Save
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
