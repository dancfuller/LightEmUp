// Settings → Backup & Restore.
//
// Everything the user has built lives in ONE file on the Pi's microSD card, and
// those cards wear out. A backup written to the Pi wouldn't survive the failure
// it exists for, so Export hands the BROWSER a download — the file leaves the
// machine. Import is destructive, so it always previews before it replaces.

const BR_CARD = { background: "#1e293b", borderRadius: 16, border: "1px solid #334155", marginBottom: 16 };

// One "12 nicknames" style row of the before/after preview. `changed` tints the
// incoming value so what this import will actually alter is obvious at a glance.
function BackupDiffRow({ label, current, incoming }) {
  const same = String(current) === String(incoming);
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "5px 0", borderBottom: "1px solid #263449" }}>
      {/* All three cells must be able to SHRINK. The rows are generated from the
          config now, so a value can be any length ("Resume unless overnight",
          a lat/lng pair) — with flex 0 0 auto those clipped off the right edge at
          390px instead of wrapping. */}
      <div style={{ flex: "1 1 auto", minWidth: 0, fontSize: 12, color: "#94a3b8",
                    overflowWrap: "anywhere" }}>{label}</div>
      <div style={{ flex: "0 1 auto", minWidth: 0, fontSize: 12, color: "#64748b",
                    textAlign: "right", overflowWrap: "anywhere" }}>{current}</div>
      <div style={{ flex: "0 0 auto", fontSize: 11, color: "#475569" }}>→</div>
      <div style={{
        flex: "0 1 auto", minWidth: 0, fontSize: 12, textAlign: "right",
        overflowWrap: "anywhere",
        color: same ? "#64748b" : "#fbbf24", fontWeight: same ? 400 : 700,
      }}>{incoming}</div>
    </div>
  );
}

function BackupRestoreCard({ onImported, isMobile }) {
  const [includeCreds, setIncludeCreds] = useState(true);
  const [busy, setBusy] = useState("");          // "export" | "preview" | "import"
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [fileName, setFileName] = useState("");
  const [payload, setPayload] = useState(null);  // parsed backup awaiting confirm
  const [preview, setPreview] = useState(null);  // dry-run response
  const [dragging, setDragging] = useState(false);
  // Cross-version restores are allowed but acknowledged — see the warning block.
  const [versionOk, setVersionOk] = useState(false);
  const fileRef = useRef(null);

  const pad = isMobile ? 14 : 20;

  const reset = () => {
    setPayload(null); setPreview(null); setFileName(""); setError(""); setVersionOk(false);
  };

  const doExport = async () => {
    setBusy("export"); setError(""); setNotice("");
    try {
      const res = await fetch(`${API}/config/export?include_credentials=${includeCreds}`,
                              { headers: { "X-Client-Id": CLIENT_ID } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      // Honour the filename the server chose (it carries hostname + date).
      const cd = res.headers.get("Content-Disposition") || "";
      const m = /filename="([^"]+)"/.exec(cd);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = m ? m[1] : "lightemup-config.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setNotice("Backup downloaded. Keep it somewhere that isn't this Pi.");
    } catch (e) {
      setError(`Export failed: ${e.message}`);
    } finally { setBusy(""); }
  };

  // Read + parse locally, then ask the server for a dry-run preview. Nothing on
  // the Pi is touched until the user confirms.
  const loadFile = async (file) => {
    if (!file) return;
    setBusy("preview"); setError(""); setNotice(""); setPreview(null); setPayload(null);
    setFileName(file.name);
    try {
      const parsed = JSON.parse(await file.text());
      const res = await api("/config/import", {
        method: "POST",
        body: JSON.stringify({ payload: parsed, dry_run: true }),
      });
      setPayload(parsed);
      setPreview(res);
      setVersionOk(false);   // a new file re-asks, even if the last one was accepted
    } catch (e) {
      setError(e instanceof SyntaxError ? "That file isn't valid JSON." : e.message);
      setFileName("");
    } finally { setBusy(""); }
  };

  const doImport = async () => {
    if (!payload) return;
    setBusy("import"); setError("");
    try {
      const res = await api("/config/import", {
        method: "POST",
        body: JSON.stringify({ payload, keep_credentials: true }),
      });
      reset();
      setNotice(`Settings restored — ${res.summary.rooms.length} rooms, ${res.summary.schedules} schedules. No restart needed.`);
      if (onImported) onImported();
    } catch (e) {
      setError(`Import failed: ${e.message}`);
    } finally { setBusy(""); }
  };

  const meta = preview && preview.meta;
  const cur = preview && preview.current;
  const inc = preview && preview.incoming;
  // Only a KNOWN difference warns. A bare config.json carries no app_version, and
  // "unknown vs 3.30.0" is not a mismatch worth crying about — the file's own
  // shape is what's checked there.
  const versionMismatch = !!(meta && meta.app_version && preview.server_version
                             && meta.app_version !== preview.server_version);
  const blockedOnVersion = versionMismatch && !versionOk;

  return (
    <div style={{ ...BR_CARD, padding: pad }}>
      <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 6, color: "#e2e8f0" }}>Backup &amp; Restore</h3>
      <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 14, lineHeight: 1.5 }}>
        Your rooms, layouts, names, calibration, scenes and schedules all live in one file on
        this Pi's memory card. Download a copy so a card failure doesn't take it with it.
      </div>

      {/* ── Export ────────────────────────────────────────────── */}
      <div style={{ background: "#16233a", borderRadius: 12, padding: isMobile ? 12 : 14, marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#e2e8f0", marginBottom: 8 }}>Download a backup</div>
        <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer", marginBottom: 10 }}>
          <input
            type="checkbox" checked={includeCreds}
            onChange={(e) => setIncludeCreds(e.target.checked)}
            style={{ marginTop: 2, cursor: "pointer" }}
          />
          <span style={{ fontSize: 12, color: "#cbd5e1", lineHeight: 1.5 }}>
            Include bridge credentials
            <span style={{ color: "#64748b" }}>
              {" "}— recommended. Without them a restore can't reach the Hue Bridge until you
              press the button on the bridge again. Treat the file as a password: it can
              control your lights.
            </span>
          </span>
        </label>
        <button
          onClick={doExport} disabled={busy === "export"}
          style={{
            padding: "10px 18px", borderRadius: 10, border: "1px solid #4f46e5",
            background: "#4f46e5", color: "#fff", fontSize: 13, fontWeight: 600,
            cursor: busy === "export" ? "default" : "pointer", opacity: busy === "export" ? 0.6 : 1,
          }}
        >{busy === "export" ? "Preparing…" : "⬇ Download backup"}</button>
      </div>

      {/* ── Import ────────────────────────────────────────────── */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault(); setDragging(false);
          loadFile(e.dataTransfer.files && e.dataTransfer.files[0]);
        }}
        style={{
          background: "#16233a", borderRadius: 12, padding: isMobile ? 12 : 14,
          border: dragging ? "1px dashed #818cf8" : "1px dashed transparent", transition: "border-color .15s",
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, color: "#e2e8f0", marginBottom: 4 }}>Restore from a backup</div>
        <div style={{ fontSize: 12, color: "#64748b", marginBottom: 10, lineHeight: 1.5 }}>
          This <strong style={{ color: "#f87171" }}>replaces every setting</strong>, including
          removing rooms the backup doesn't have. You'll see exactly what changes before
          anything is applied, and the current settings are backed up on the Pi first.
        </div>

        <input
          ref={fileRef} type="file" accept="application/json,.json"
          onChange={(e) => loadFile(e.target.files && e.target.files[0])}
          style={{ display: "none" }}
        />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button
            onClick={() => fileRef.current && fileRef.current.click()}
            disabled={busy === "preview"}
            style={{
              padding: "9px 16px", borderRadius: 10, border: "1px solid #334155",
              background: "transparent", color: "#a5b4fc", fontSize: 13, fontWeight: 600,
              cursor: "pointer",
            }}
          >{busy === "preview" ? "Reading…" : "Choose backup file…"}</button>
          {fileName && (
            <span style={{ fontSize: 12, color: "#94a3b8", wordBreak: "break-all", flex: "1 1 120px" }}>
              {fileName}
            </span>
          )}
        </div>
        {!isMobile && (
          <div style={{ fontSize: 11, color: "#475569", marginTop: 8 }}>…or drag a backup file onto this box.</div>
        )}

        {/* Pre-import preview */}
        {preview && (
          <div style={{ marginTop: 14, background: "#0f1b2e", borderRadius: 10, padding: isMobile ? 10 : 14, border: "1px solid #334155" }}>
            <div style={{ fontSize: 12, color: "#e2e8f0", fontWeight: 700, marginBottom: 2 }}>What this will change</div>
            <div style={{ fontSize: 11, color: "#64748b", marginBottom: 10 }}>
              {meta && meta.app_version
                ? `From LightEmUp v${meta.app_version}${meta.hostname ? ` on ${meta.hostname}` : ""}${meta.exported_at ? `, ${String(meta.exported_at).replace("T", " ")}` : ""}`
                : "Plain config file — no backup details recorded in it"}
              {meta && meta.includes_credentials === false && " · no credentials inside (your current ones are kept)"}
            </div>

            <div style={{ display: "flex", gap: 8, fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: 0.5, paddingBottom: 4 }}>
              <div style={{ flex: "1 1 auto" }} />
              <div>now</div><div style={{ width: 10 }} /><div>after</div>
            </div>

            {/* Rows come from the SERVER, derived from the config keys themselves —
                they are not listed here. That's deliberate: this used to be eleven
                hand-written lines, and every setting added after v3.11.0 was simply
                missing from the preview. Don't reintroduce a hand-list; if a row
                reads badly, give the key a label in _SETTING_LABELS in main.py. */}
            {(preview.rows || []).map((r) => (
              <BackupDiffRow
                key={r.key}
                label={r.unknown ? `${r.label} *` : r.label}
                current={r.current}
                incoming={r.incoming}
              />
            ))}
            {(preview.rows || []).some((r) => r.unknown) && (
              <div style={{ fontSize: 10, color: "#64748b", marginTop: 6 }}>
                * a setting this version doesn't recognise — it's carried over untouched.
              </div>
            )}

            {/* Naming the rooms that disappear is the check that catches a wrong file. */}
            {(() => {
              const lost = cur.rooms.filter((r) => inc.rooms.indexOf(r) === -1);
              const gained = inc.rooms.filter((r) => cur.rooms.indexOf(r) === -1);
              if (!lost.length && !gained.length) return (
                <div style={{ fontSize: 11, color: "#4ade80", marginTop: 10 }}>Same rooms as now.</div>
              );
              return (
                <div style={{ marginTop: 10, fontSize: 11, lineHeight: 1.6 }}>
                  {lost.length > 0 && (
                    <div style={{ color: "#f87171" }}>Removed: {lost.join(", ")}</div>
                  )}
                  {gained.length > 0 && (
                    <div style={{ color: "#4ade80" }}>Added: {gained.join(", ")}</div>
                  )}
                </div>
              );
            })()}

            {/* Cross-version restore: a CAUTION, not a block. A backup from another
                build is the normal case for the restore that matters most — an old
                file onto a rebuilt Pi running the current version — so the only hard
                refusal stays the schema check in _unwrap_import. This just makes sure
                the user saw it. Acknowledging gates the destructive button rather
                than firing the import, so "OK" never means "do it now". */}
            {versionMismatch && !versionOk && (
              <div style={{
                marginTop: 12, padding: isMobile ? 10 : 12, borderRadius: 10,
                background: "rgba(251,191,36,0.07)", border: "1px solid rgba(251,191,36,0.3)",
              }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#fbbf24", marginBottom: 4 }}>
                  Different version
                </div>
                <div style={{ fontSize: 12, color: "#cbd5e1", lineHeight: 1.55 }}>
                  This backup was made by LightEmUp <strong>v{meta.app_version}</strong>, but this
                  hub is running <strong>v{preview.server_version}</strong>. Restoring across
                  versions normally works — settings added since are kept at their defaults, and
                  anything this build doesn't recognise is carried over untouched. Check the list
                  above before continuing.
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                  <button
                    onClick={() => setVersionOk(true)}
                    style={{
                      padding: "8px 16px", borderRadius: 8, border: "1px solid #b45309",
                      background: "rgba(251,191,36,0.15)", color: "#fde68a",
                      fontSize: 12, fontWeight: 700, cursor: "pointer",
                    }}
                  >OK, continue</button>
                  <button
                    onClick={reset}
                    style={{
                      padding: "8px 16px", borderRadius: 8, border: "1px solid #334155",
                      background: "transparent", color: "#94a3b8",
                      fontSize: 12, fontWeight: 600, cursor: "pointer",
                    }}
                  >Cancel import</button>
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
              <button
                onClick={doImport} disabled={busy === "import" || blockedOnVersion}
                title={blockedOnVersion ? "Acknowledge the version difference above first" : ""}
                style={{
                  padding: "10px 18px", borderRadius: 10, border: "1px solid #b91c1c",
                  background: "#b91c1c", color: "#fff", fontSize: 13, fontWeight: 700,
                  cursor: (busy === "import" || blockedOnVersion) ? "default" : "pointer",
                  opacity: (busy === "import" || blockedOnVersion) ? 0.5 : 1,
                  flex: isMobile ? "1 1 100%" : "0 0 auto",
                }}
              >{busy === "import" ? "Restoring…" : "Replace all settings"}</button>
              <button
                onClick={reset}
                style={{
                  padding: "10px 18px", borderRadius: 10, border: "1px solid #334155",
                  background: "transparent", color: "#94a3b8", fontSize: 13, fontWeight: 600,
                  cursor: "pointer", flex: isMobile ? "1 1 100%" : "0 0 auto",
                }}
              >Cancel</button>
            </div>
          </div>
        )}
      </div>

      {error && (
        <div style={{ marginTop: 12, padding: 10, borderRadius: 10, background: "#3f1d1d", border: "1px solid #7f1d1d", color: "#fecaca", fontSize: 12 }}>
          {error}
        </div>
      )}
      {notice && (
        <div style={{ marginTop: 12, padding: 10, borderRadius: 10, background: "#14342a", border: "1px solid #166534", color: "#bbf7d0", fontSize: 12 }}>
          {notice}
        </div>
      )}
    </div>
  );
}
