# Proxmox API Reference

**Base URL:** `PROXMOX_API_URL` i `~/.opencode/.env`, typisk `https://<node>:8006/api2/json`
**Auth header:** `Authorization: PVEAPIToken=<bruker>@pam!<token>={SECRET}`
**Role:** PVEAuditor (read-only)
**SSL:** Selvsignert — alle curl-kall må ha `-k`

## Autentisering

Les credentials fra `.env` og sett auth-header:

```bash
source ~/.opencode/.env
AUTH="Authorization: PVEAPIToken=${PROXMOX_TOKEN_ID}=${PROXMOX_TOKEN_SECRET}"
BASE="${PROXMOX_API_URL}"
```

API-token er stateless — ingen cookie/CSRF trengs for GET-kall.

## Cluster

| Endpoint | Beskrivelse |
|----------|-------------|
| `GET /cluster/status` | Cluster quorum, noder, online-status |
| `GET /cluster/resources` | Alle ressurser: VM, LXC, storage, nodes med CPU/RAM/disk-metrikk |
| `GET /cluster/tasks` | Nylige cluster-tasks |

### Cluster status respons
```json
[{"type":"cluster","name":"lab-cluster","quorate":1,"nodes":2},
 {"type":"node","name":"pve","online":1,"ip":"10.0.0.10"},
 {"type":"node","name":"pve2","online":1,"ip":"10.0.0.11"}]
```

### Resources respons (eksempel)
```json
{"type":"qemu","vmid":100,"name":"home-assistant-os","status":"running","node":"pve2",
 "cpu":0.01,"maxcpu":2,"mem":1818300416,"maxmem":8589934592,
 "disk":0,"maxdisk":34359738368,"uptime":95282}
```

`type` kan være: `qemu`, `lxc`, `node`, `storage`, `sdn`, `network`.

## Nodes

| Endpoint | Beskrivelse |
|----------|-------------|
| `GET /nodes` | Alle noder med oppetid, CPU, RAM |
| `GET /nodes/{node}/status` | Detaljert node-status (load, minne, CPU-info, PVE-versjon) |
| `GET /nodes/{node}/storage` | Storage per node med bruk/ledig |
| `GET /nodes/{node}/tasks` | Node-tasks (ferdigstilte) |

### QEMU VMs på node
| Endpoint | Beskrivelse |
|----------|-------------|
| `GET /nodes/{node}/qemu` | VM-liste med status, CPU, RAM, disk |
| `GET /nodes/{node}/qemu/{vmid}/config` | Full VM-konfig |
| `GET /nodes/{node}/qemu/{vmid}/status/current` | Runtime status detaljer |

### LXC Containers på node
| Endpoint | Beskrivelse |
|----------|-------------|
| `GET /nodes/{node}/lxc` | Container-liste med status, CPU, RAM |
| `GET /nodes/{node}/lxc/{vmid}/config` | Full container-konfig |
| `GET /nodes/{node}/lxc/{vmid}/status/current` | Runtime status detaljer |

## Storage

| Endpoint | Beskrivelse |
|----------|-------------|
| `GET /storage` | Alle storage pools med type, innhold, nodes |
| `GET /storage/{storage}/status` | Storage-status per node (bruk/ledig/total) |

## Tasks

| Endpoint | Beskrivelse |
|----------|-------------|
| `GET /cluster/tasks` | Siste cluster-tasks |
| `GET /nodes/{node}/tasks` | Tasks per node med filtre: `statusfilter`, `limit`, `since`, `until` |
| `GET /nodes/{node}/tasks/{upid}/status` | Enkelt task-status (running/stopped, exitstatus) |
| `GET /nodes/{node}/tasks/{upid}/log` | Task log-output |

## Felles mønstre

- Alle responser wrapper i `{"data": [...]}`
- VMID range: 100–999999999
- `node`-parameter kreves for alle node-scopede kall
- Mem/disk-verdier i bytes — konverter til GB/MB for lesbarhet
- `status`: `running`, `stopped` (og `paused` for QEMU)
- `maxcpu` = antall tilgjengelige CPU-kjerner
