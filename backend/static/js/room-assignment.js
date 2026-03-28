// ─── Room Assignment Component ──────────────────────────────────────────────

function DeviceRow({ device, roomName, allRoomNames, onMove, onRemove, nicknames }) {
  const isHue = device.type === "hue";
  const { nickname, friendlyName } = getDeviceDisplayName(device, nicknames);
  const subtitle = isHue
    ? device.product_name || device.model || "Hue"
    : device.sku || device.ip;

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      padding: "10px 14px", borderRadius: 12,
      background: "#0f172a", border: "1px solid #334155",
    }}>
      <div style={{
        width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
        background: isHue ? "#c084fc" : "#34d399",
      }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {nickname && (
          <div style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {nickname}
          </div>
        )}
        <div style={{
          fontSize: nickname ? 11 : 13, fontWeight: nickname ? 500 : 600,
          color: nickname ? "#94a3b8" : "#e2e8f0",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {friendlyName}
        </div>
        <div style={{ fontSize: 10, color: "#64748b", marginTop: 1 }}>{subtitle}</div>
      </div>
      {roomName && (
        <select
          value={roomName}
          onChange={(e) => onMove(device, roomName, e.target.value)}
          style={{
            padding: "5px 8px", borderRadius: 8, border: "1px solid #334155",
            background: "#1e293b", color: "#e2e8f0", fontSize: 12,
            cursor: "pointer", outline: "none", minWidth: 100,
          }}
        >
          {allRoomNames.map(rn => (
            <option key={rn} value={rn}>{rn}</option>
          ))}
        </select>
      )}
      {onRemove && (
        <button
          onClick={() => onRemove(device, roomName)}
          style={{
            padding: "5px 10px", borderRadius: 8, border: "none",
            background: "rgba(248,113,113,0.12)", color: "#f87171",
            cursor: "pointer", fontSize: 12, fontWeight: 600,
            whiteSpace: "nowrap",
          }}
        >Remove</button>
      )}
    </div>
  );
}

function DevicePickerModal({ title, devices, onSelect, onClose, nicknames }) {
  if (devices.length === 0) return null;
  const [selected, setSelected] = useState(new Set());

  const toggle = (d) => {
    const key = d.type === "hue" ? `hue:${d.id}` : `govee:${d.ip}`;
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const getKey = (d) => d.type === "hue" ? `hue:${d.id}` : `govee:${d.ip}`;

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1000,
      background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 16,
    }} onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#1e293b", borderRadius: 20, border: "1px solid #334155",
          width: "100%", maxWidth: 420, maxHeight: "80vh",
          display: "flex", flexDirection: "column",
        }}
      >
        <div style={{ padding: "20px 20px 12px", borderBottom: "1px solid #0f172a" }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, color: "#f1f5f9", margin: 0 }}>{title}</h3>
          <p style={{ fontSize: 12, color: "#64748b", margin: "4px 0 0" }}>
            Tap to select, then confirm.
          </p>
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: "12px 20px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {devices.map((d, i) => {
              const key = getKey(d);
              const isSelected = selected.has(key);
              const isHue = d.type === "hue";
              const { nickname, friendlyName } = getDeviceDisplayName(d, nicknames);
              const subtitle = isHue ? (d.product_name || d.model || "Hue") : (d.sku || d.ip);
              return (
                <button
                  key={`pick-${key}-${i}`}
                  onClick={() => toggle(d)}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "12px 14px", borderRadius: 12, border: "none",
                    background: isSelected ? "rgba(99,102,241,0.15)" : "#0f172a",
                    outline: isSelected ? "2px solid #6366f1" : "1px solid #334155",
                    cursor: "pointer", textAlign: "left", width: "100%",
                    transition: "all 0.15s ease",
                  }}
                >
                  <div style={{
                    width: 22, height: 22, borderRadius: 6, flexShrink: 0,
                    border: isSelected ? "none" : "2px solid #475569",
                    background: isSelected ? "#6366f1" : "transparent",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 14, color: "#fff",
                  }}>
                    {isSelected ? "✓" : ""}
                  </div>
                  <div style={{
                    width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
                    background: isHue ? "#c084fc" : "#34d399",
                  }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {nickname && (
                      <div style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0" }}>{nickname}</div>
                    )}
                    <div style={{
                      fontSize: nickname ? 11 : 13, fontWeight: nickname ? 500 : 600,
                      color: nickname ? "#94a3b8" : "#e2e8f0",
                    }}>{friendlyName}</div>
                    <div style={{ fontSize: 10, color: "#64748b", marginTop: 1 }}>{subtitle}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
        <div style={{
          padding: "12px 20px 20px", borderTop: "1px solid #0f172a",
          display: "flex", gap: 8, justifyContent: "flex-end",
        }}>
          <button onClick={onClose} style={{
            padding: "10px 20px", borderRadius: 10, border: "1px solid #334155",
            background: "transparent", color: "#94a3b8", fontSize: 13,
            fontWeight: 600, cursor: "pointer",
          }}>Cancel</button>
          <button
            disabled={selected.size === 0}
            onClick={() => {
              const picked = devices.filter(d => selected.has(getKey(d)));
              onSelect(picked);
              onClose();
            }}
            style={{
              padding: "10px 20px", borderRadius: 10, border: "none",
              background: selected.size > 0 ? "#6366f1" : "#334155",
              color: selected.size > 0 ? "#fff" : "#64748b",
              fontSize: 13, fontWeight: 600,
              cursor: selected.size > 0 ? "pointer" : "default",
            }}
          >Add {selected.size > 0 ? `(${selected.size})` : ""}</button>
        </div>
      </div>
    </div>
  );
}

function RoomCard({ roomName, devices, allRoomNames, unassigned, onMoveDevice, onRemoveDevice, onAddDevices, onDeleteRoom, isDefault, nicknames }) {
  const [showPicker, setShowPicker] = useState(false);

  return (
    <>
      <div style={{
        background: "#1e293b", borderRadius: 16, padding: 20,
        border: "1px solid #334155", marginBottom: 16,
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, color: "#f1f5f9", margin: 0 }}>{roomName}</h3>
            <span style={{
              fontSize: 11, color: "#64748b", background: "#0f172a",
              padding: "2px 8px", borderRadius: 10,
            }}>{devices.length}</span>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {unassigned.length > 0 && (
              <button
                onClick={() => setShowPicker(true)}
                style={{
                  padding: "6px 14px", borderRadius: 8, border: "none",
                  background: "#6366f1", color: "#fff",
                  fontSize: 12, fontWeight: 600, cursor: "pointer",
                }}
              >+ Add Devices</button>
            )}
            {!isDefault && (
              <button
                onClick={() => onDeleteRoom(roomName)}
                style={{
                  padding: "6px 14px", borderRadius: 8, border: "none",
                  background: "rgba(248,113,113,0.1)", color: "#f87171",
                  fontSize: 12, fontWeight: 600, cursor: "pointer",
                }}
              >Delete</button>
            )}
          </div>
        </div>
        {devices.length === 0 ? (
          <div style={{
            padding: 24, borderRadius: 10, border: "1px dashed #334155",
            textAlign: "center", color: "#475569", fontSize: 13,
          }}>
            No devices assigned
            {unassigned.length > 0 && (
              <span> — tap <strong style={{ color: "#a5b4fc" }}>+ Add Devices</strong> above</span>
            )}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {devices.map((d, i) => (
              <DeviceRow
                key={`${d.type}-${d.id || d.ip}-${i}`}
                device={d}
                roomName={roomName}
                allRoomNames={allRoomNames}
                onMove={onMoveDevice}
                onRemove={onRemoveDevice}
                nicknames={nicknames}
              />
            ))}
          </div>
        )}
      </div>

      {showPicker && (
        <DevicePickerModal
          title={`Add devices to ${roomName}`}
          devices={unassigned}
          onSelect={(picked) => onAddDevices(roomName, picked)}
          onClose={() => setShowPicker(false)}
          nicknames={nicknames}
        />
      )}
    </>
  );
}

function RoomAssignment({ hueLights, goveeDevices, rooms, onRoomsChange, nicknames }) {
  const [newRoomName, setNewRoomName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null);

  const getDevicesForRoom = (roomName) => {
    const room = rooms[roomName] || {};
    return [
      ...hueLights.filter(l => (room.hue_light_ids || []).includes(l.id)),
      ...goveeDevices.filter(d => (room.govee_devices || []).includes(d.ip)),
    ];
  };

  const getUnassigned = () => {
    const assignedHueIds = new Set();
    const assignedGoveeIps = new Set();
    Object.values(rooms).forEach(r => {
      (r.hue_light_ids || []).forEach(id => assignedHueIds.add(id));
      (r.govee_devices || []).forEach(ip => assignedGoveeIps.add(ip));
    });
    return [
      ...hueLights.filter(l => !assignedHueIds.has(l.id)),
      ...goveeDevices.filter(d => !assignedGoveeIps.has(d.ip)),
    ];
  };

  const moveDevice = (device, fromRoom, toRoom) => {
    if (fromRoom === toRoom) return;
    const updated = JSON.parse(JSON.stringify(rooms));

    // Remove from source
    if (updated[fromRoom]) {
      if (device.type === "hue") {
        updated[fromRoom].hue_light_ids = (updated[fromRoom].hue_light_ids || []).filter(id => id !== device.id);
      } else {
        updated[fromRoom].govee_devices = (updated[fromRoom].govee_devices || []).filter(ip => ip !== device.ip);
      }
    }

    // Add to target
    if (!updated[toRoom]) updated[toRoom] = { hue_light_ids: [], govee_devices: [] };
    if (device.type === "hue") {
      if (!(updated[toRoom].hue_light_ids || []).includes(device.id)) {
        updated[toRoom].hue_light_ids = [...(updated[toRoom].hue_light_ids || []), device.id];
      }
    } else {
      if (!(updated[toRoom].govee_devices || []).includes(device.ip)) {
        updated[toRoom].govee_devices = [...(updated[toRoom].govee_devices || []), device.ip];
      }
    }

    onRoomsChange(updated);
  };

  const removeDevice = (device, roomName) => {
    const updated = JSON.parse(JSON.stringify(rooms));
    if (device.type === "hue") {
      updated[roomName].hue_light_ids = (updated[roomName].hue_light_ids || []).filter(id => id !== device.id);
    } else {
      updated[roomName].govee_devices = (updated[roomName].govee_devices || []).filter(ip => ip !== device.ip);
    }
    onRoomsChange(updated);
  };

  const addDevicesToRoom = (roomName, devices) => {
    const updated = JSON.parse(JSON.stringify(rooms));
    if (!updated[roomName]) updated[roomName] = { hue_light_ids: [], govee_devices: [] };
    for (const d of devices) {
      if (d.type === "hue") {
        if (!(updated[roomName].hue_light_ids || []).includes(d.id)) {
          updated[roomName].hue_light_ids = [...(updated[roomName].hue_light_ids || []), d.id];
        }
      } else {
        if (!(updated[roomName].govee_devices || []).includes(d.ip)) {
          updated[roomName].govee_devices = [...(updated[roomName].govee_devices || []), d.ip];
        }
      }
    }
    onRoomsChange(updated);
  };

  const addRoom = () => {
    const name = newRoomName.trim();
    if (!name || rooms[name]) return;
    onRoomsChange({ ...rooms, [name]: { hue_light_ids: [], govee_devices: [] } });
    setNewRoomName("");
  };

  const deleteRoom = (name) => {
    const updated = { ...rooms };
    delete updated[name];
    onRoomsChange(updated);
  };

  const saveAll = async () => {
    setSaving(true);
    setSaveStatus(null);
    try {
      for (const [name, room] of Object.entries(rooms)) {
        await api("/rooms", {
          method: "POST",
          body: JSON.stringify({
            name,
            hue_light_ids: room.hue_light_ids || [],
            govee_devices: room.govee_devices || [],
          }),
        });
      }
      setSaveStatus("success");
      setTimeout(() => setSaveStatus(null), 3000);
    } catch {
      setSaveStatus("error");
    }
    setSaving(false);
  };

  const unassigned = getUnassigned();
  const allRoomNames = Object.keys(rooms);
  const defaultRooms = ["Bedroom", "Living Room", "Outside"];

  return (
    <div>
      <div style={{
        display: "flex", flexWrap: "wrap", justifyContent: "space-between",
        alignItems: "center", gap: 12, marginBottom: 20,
      }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: "#f8fafc", margin: 0 }}>Room Assignment</h2>
          <p style={{ fontSize: 13, color: "#64748b", margin: "4px 0 0" }}>
            Add devices to rooms, reassign with the dropdown, or remove them.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {saveStatus === "success" && <span style={{ fontSize: 12, color: "#4ade80" }}>✓ Saved</span>}
          {saveStatus === "error" && <span style={{ fontSize: 12, color: "#f87171" }}>Save failed</span>}
          <button
            onClick={saveAll} disabled={saving}
            style={{
              padding: "8px 24px", borderRadius: 10, border: "none",
              background: saving ? "#475569" : "#6366f1",
              color: "#fff", fontSize: 13, fontWeight: 600,
              cursor: saving ? "wait" : "pointer",
            }}
          >{saving ? "Saving..." : "Save Rooms"}</button>
        </div>
      </div>

      {/* Legend */}
      <div style={{
        display: "flex", gap: 16, marginBottom: 20, padding: "10px 16px",
        background: "#0f172a", borderRadius: 10, border: "1px solid #1e293b",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#94a3b8" }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#c084fc" }} /> Hue / Zigbee
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#94a3b8" }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#34d399" }} /> Govee
        </div>
        {unassigned.length > 0 && (
          <div style={{ fontSize: 12, color: "#fbbf24", marginLeft: "auto" }}>
            {unassigned.length} unassigned
          </div>
        )}
      </div>

      {/* Room cards */}
      {allRoomNames.map(roomName => (
        <RoomCard
          key={roomName}
          roomName={roomName}
          devices={getDevicesForRoom(roomName)}
          allRoomNames={allRoomNames}
          unassigned={unassigned}
          onMoveDevice={moveDevice}
          onRemoveDevice={removeDevice}
          onAddDevices={addDevicesToRoom}
          onDeleteRoom={deleteRoom}
          isDefault={defaultRooms.includes(roomName)}
          nicknames={nicknames}
        />
      ))}

      {/* Unassigned section */}
      {unassigned.length > 0 && (
        <div style={{
          background: "#1e293b", borderRadius: 16, padding: 20,
          border: "1px dashed #475569", marginBottom: 16,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, color: "#fbbf24", margin: 0 }}>Unassigned</h3>
            <span style={{
              fontSize: 11, color: "#64748b", background: "#0f172a",
              padding: "2px 8px", borderRadius: 10,
            }}>{unassigned.length}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {unassigned.map((d, i) => {
              const isHue = d.type === "hue";
              const { nickname, friendlyName } = getDeviceDisplayName(d, nicknames);
              const subtitle = isHue ? (d.product_name || d.model || "Hue") : (d.sku || d.ip);
              return (
                <div key={`unassigned-${d.type}-${d.id || d.ip}-${i}`} style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "10px 14px", borderRadius: 12,
                  background: "#0f172a", border: "1px solid #334155",
                }}>
                  <div style={{
                    width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
                    background: isHue ? "#c084fc" : "#34d399",
                  }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {nickname && (
                      <div style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0" }}>{nickname}</div>
                    )}
                    <div style={{
                      fontSize: nickname ? 11 : 13, fontWeight: nickname ? 500 : 600,
                      color: nickname ? "#94a3b8" : "#e2e8f0",
                    }}>{friendlyName}</div>
                    <div style={{ fontSize: 10, color: "#64748b", marginTop: 1 }}>{subtitle}</div>
                  </div>
                  <select
                    value=""
                    onChange={(e) => {
                      if (e.target.value) addDevicesToRoom(e.target.value, [d]);
                    }}
                    style={{
                      padding: "5px 8px", borderRadius: 8, border: "1px solid #334155",
                      background: "#1e293b", color: "#a5b4fc", fontSize: 12,
                      cursor: "pointer", outline: "none",
                    }}
                  >
                    <option value="">Assign to...</option>
                    {allRoomNames.map(rn => (
                      <option key={rn} value={rn}>{rn}</option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Add room */}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <input
          type="text" value={newRoomName}
          onChange={(e) => setNewRoomName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addRoom()}
          placeholder="New room name..."
          style={{
            flex: 1, padding: "10px 14px", borderRadius: 10,
            border: "1px solid #334155", background: "#0f172a",
            color: "#f1f5f9", fontSize: 13, outline: "none",
          }}
        />
        <button
          onClick={addRoom} disabled={!newRoomName.trim()}
          style={{
            padding: "10px 20px", borderRadius: 10, border: "none",
            background: newRoomName.trim() ? "#334155" : "#1e293b",
            color: newRoomName.trim() ? "#f1f5f9" : "#475569",
            fontSize: 13, fontWeight: 600, cursor: newRoomName.trim() ? "pointer" : "default",
          }}
        >+ Add Room</button>
      </div>
    </div>
  );
}
