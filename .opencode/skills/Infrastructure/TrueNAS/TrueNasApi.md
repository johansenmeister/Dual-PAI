# TrueNAS API Reference

**Protokoll:** JSON-RPC 2.0 over WebSocket  
**Endepunkt:** `wss://<vert>/api/current` (fra `TRUENAS_API_URL`)  
**Versjon:** 25.04.2 Fangtooth  
**Rolle:** Readonly Admin (pai-api)

REST API (`/api/v2.0/`) er deprecated i Fangtooth — WebSocket er eneste støttede API.

## Autentisering

To-stegs flyt over WebSocket:

```typescript
// Steg 1: Koble til og autentiser
const ws = new WebSocket(`${url}/api/current`);

ws.onopen = () => {
  ws.send(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "auth.login_ex",
    params: [{
      mechanism: "API_KEY_PLAIN",
      username: "pai-api",
      api_key: TRUENAS_API_KEY   // fra ~/.opencode/.env
    }]
  }));
};

// Steg 2: Vent på SUCCESS, send deretter operasjoner
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id === 1 && msg.result?.response_type === "SUCCESS") {
    // Autentisert — send operasjoner
    ws.send(JSON.stringify({jsonrpc: "2.0", id: 2, method: "system.info"}));
  }
  if (msg.id >= 2) {
    // Håndter respons
    console.log(msg.result);
    ws.close();
  }
};
```

**Credentials** fra `~/.opencode/.env`:
```bash
TRUENAS_API_URL=https://<vert>/api/v2.0                  # REST base (for dokumentasjon)
TRUENAS_API_KEY=<din-nøkkel>
```

## API-kall mønster

### System

| Metode | Beskrivelse | Responsnøkler |
|--------|-------------|---------------|
| `system.info` | Systeminformasjon | `version`, `hostname`, `uptime`, `system_product`, `system_manufacturer`, `cpu_model`, `physical_cores`, `license` |
| `system.product_type` | Produkttype | `SCALE`, `CORE`, `SCALE_ENTERPRISE` |
| `system.host_id` | Unik host-ID | `id` |
| `system.state` | System state (BOOT, READY, SHUTTING_DOWN) | `state` |
| `system.ready` | Abonner på systemklar | Event: `true` når klar |

### Pool & Disk

| Metode | Beskrivelse | Responsnøkler |
|--------|-------------|---------------|
| `pool.query` | Alle pools | `name`, `status`, `scan`, `topology`, `healthy`, `properties` |
| `pool.config` | Pool-konfigurasjon | — |
| `disk.query` | Alle disker | `name`, `serial`, `size`, `model`, `temperature`, `enclosure` |
| `disk.temperatures` | Alle disktemperaturer | `{disk_name: temperature}` |
| `disk.temperature_agg` | Aggregerte temps | `min`, `max`, `avg` |
| `smart.test.results` | Siste SMART-testresultater | Per-disk resultater |

### Dataset

| Metode | Beskrivelse | Responsnøkler |
|--------|-------------|---------------|
| `pool.dataset.query` | Alle datasets | `name`, `pool`, `type`, `used`, `available`, `mountpoint`, `encrypted` |
| `pool.dataset.details` | Detaljert dataset-info | Utvidet info for spesifikt dataset |
| `zfs.snapshot.query` | Snapshots | `name`, `pool`, `dataset` |
| `pool.snapshottask.query` | Snapshot tasks | Planlagte snapshot-oppgaver |

### Shares

| Metode | Beskrivelse | Responsnøkler |
|--------|-------------|---------------|
| `sharing.smb.query` | SMB-shares | `name`, `path`, `enabled`, `comment`, `purpose` |
| `sharing.nfs.query` | NFS-shares | `path`, `enabled`, `networks`, `comment` |
| `sharing.iscsi.target.query` | iSCSI targets | Target-konfigurasjon |
| `smb.config` | Global SMB-konfig | `workgroup`, `netbiosname`, `server_string` |
| `nfs.config` | Global NFS-konfig | `servers`, `udp`, `userd_manage_gids` |
| `smb.status` | SMB tilkoblinger | Aktive SMB-klienter |
| `nfs.client_count` | NFS tilkoblinger | Aktive NFS-klienter |

### Varsler

| Metode | Beskrivelse | Responsnøkler |
|--------|-------------|---------------|
| `alert.list` | Aktive varsler | `id`, `level`, `title`, `dismissed`, `datetime` |
| `alert.list_categories` | Varselkategorier | Kategorier og antall |
| `alert.list_policies` | Varslingsregler | `id`, `title`, `enabled` |

### Nettverk

| Metode | Beskrivelse | Responsnøkler |
|--------|-------------|---------------|
| `interface.query` | Nettverksgrensesnitt | `name`, `state`, `aliases`, `vlans`, `link_state` |
| `network.general.summary` | Nettverksammendrag | `ips`, `default_routes`, `nameservers` |
| `staticroute.query` | Statiske ruter | `destination`, `gateway`, `description` |

### Tjenester

| Metode | Beskrivelse | Responsnøkler |
|--------|-------------|---------------|
| `service.query` | Alle tjenester | `service`, `state`, `enable` |
| `service.started` | Sjekk om tjeneste kjører | `true`/`false` |

### Replikering & Backup

| Metode | Beskrivelse | Responsnøkler |
|--------|-------------|---------------|
| `replication.query` | Replikeringsoppgaver | `name`, `state`, `transport`, `source_datasets` |
| `cloudsync.query` | Cloud sync-oppgaver | `description`, `direction`, `transfer_mode` |
| `cloud_backup.query` | Cloud backup | `description`, `state` |
| `rsynctask.query` | Rsync-oppgaver | `path`, `enabled`, `mode` |

### VM & App

| Metode | Beskrivelse | Responsnøkler |
|--------|-------------|---------------|
| `vm.query` | Virtuelle maskiner | `name`, `status`, `vcpus`, `memory`, `autostart` |
| `app.query` | Installerte apper | App-status og konfigurasjon |
| `docker.status` | Docker-status | `status`, docker info |

### Brukere & Grupper

| Metode | Beskrivelse | Responsnøkler |
|--------|-------------|---------------|
| `user.query` | Lokale brukere | `username`, `full_name`, `uid`, `shell`, `home` |
| `group.query` | Lokale grupper | `name`, `gid`, `users` |
| `privilege.query` | Privilegier | Rettighetstildelinger |

### Sikkerhet

| Metode | Beskrivelse | Responsnøkler |
|--------|-------------|---------------|
| `audit.query` | Revisjonslogg | `timestamp`, `username`, `service`, `event` |
| `auth.sessions` | Aktive sesjoner | Nåværende sesjoner |

## Generelt Bun-skriptmønster

Se `Workflows/CheckStatus.md` for fullstendig eksempel. Grunnmønster:

```typescript
const ws = new WebSocket("wss://<vert>/api/current");
const KEY = process.env.TRUENAS_API_KEY;

const calls: Array<{method: string, id: number}> = [
  {method: "pool.query", id: 2},
  {method: "disk.query", id: 3},
];
let results: Record<number, any> = {};
let callIndex = 0;
let authenticated = false;

ws.onopen = () => {
  ws.send(JSON.stringify({jsonrpc:"2.0", id:1, method:"auth.login_ex",
    params:[{mechanism:"API_KEY_PLAIN", username:"pai-api", api_key:KEY}]}));
};

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id === 1) {
    if (msg.result?.response_type === "SUCCESS") {
      authenticated = true;
      // Send first operation
      if (calls.length > 0)
        ws.send(JSON.stringify({jsonrpc:"2.0", id:calls[0].id, method:calls[0].method}));
    } else {
      console.error("Auth failed:", msg.error);
      ws.close();
      process.exit(1);
    }
    return;
  }
  
  results[msg.id] = msg.result;
  
  // Send next call or finish
  callIndex++;
  if (callIndex < calls.length) {
    ws.send(JSON.stringify({jsonrpc:"2.0", id:calls[callIndex].id, method:calls[callIndex].method}));
  } else {
    ws.close();
  }
};

ws.onclose = () => {
  console.log(JSON.stringify(results, null, 2));
};

setTimeout(() => { ws.close(); process.exit(1); }, 15000);
```

## Viktige merknader

- **REST deprecated:** IKKE bruk `/api/v2.0/` — gir 403 for Readonly Admin i Fangtooth
- **WebSocket state:** Hold tilkoblingen åpen for multiple kall — reconnect er tregt
- **SSL:** Selvsignert sertifikat — Bun aksepterer dette automatisk
- **Timeout:** Sett 15s timeout for å unngå hengende WebSocket
- **Feilhåndtering:** Sjekk `msg.error` på alle responser — `ENOTAUTHENTICATED` betyr ute av sesjon
- **Escape:** Bun krever `PERMISSIVE_SSL=1` for selvsignerte sertifikater i noen versjoner; hvis feil, legg til: `process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"`
