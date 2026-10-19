#!/usr/bin/env bash
#
# check-firewall.sh — Henter og aggregerer OPNsense brannmur-status
#
# All datainnhenting og telling skjer deterministisk her (curl + jq).
# Modellen (eller n8n) får kun ferdig aggregert, kompakt JSON på stdout.
#
# Bruk:
#   ./check-firewall.sh              # kompakt JSON til stdout
#   ./check-firewall.sh --pretty    # pen JSON (jq .)
#   ./check-firewall.sh --csv FIL   # les forrige rad i FIL for delta, append så en ny rad
#   ./check-firewall.sh --history   # som --csv, med FIREWALL_HISTORY_CSV fra .env
#                                   # (standard ~/.opencode/MEMORY/STATE/firewall-history.csv)
#   ./check-firewall.sh --detail    # inkluder detaljert CrowdSec ban-liste
#   ./check-firewall.sh --ip 1.2.3.4  # filtrer filterlogg på én IP (src eller dst)
#   ./check-firewall.sh --rules      # inkluder alle ikke-legacy filterregler (kompakt)
#
# Exit-koder:
#   0 = OK, data hentet
#   1 = manglende credentials/miljø
#   2 = autentiseringsfeil (401/403)
#   3 = OPNsense ikke tilgjengelig (timeout/nettverk)
#   4 = uventet API-feil
#
# KUN GET, med ett unntak: /api/ids/service/queryAlerts krever POST (pagineringen
# står i body) og er et søk, ikke en skriving. GET mot den gir bare []. api_post
# nekter alle andre stier, så unntaket er håndhevet her og ikke bare i prompten.
# Dette scriptet skriver ALDRI til brannmuren.

set -euo pipefail

ENV_FILE="${OPNSENSE_ENV_FILE:-$HOME/.opencode/.env}"
LOG_LIMIT="${LOG_LIMIT:-50}"
CURL_TIMEOUT="${CURL_TIMEOUT:-15}"
IDS_LIMIT="${IDS_LIMIT:-100}"
# Seriene og utgavene endepunktene i OpnSenseApi.md er verifisert mot, som serie/utgave
# (#414, #466). Kjører brannmuren noe annet, blir overall ADVARSEL. En ny kombinasjon
# legges til i samme commit som verifiseringen, her og i OpnSenseApi.md.
VERIFIED="26.7/CE"
PRETTY=0
DETAIL=0
IP_FILTER=""
RULES_DUMP=0
CSV_FILE=""
HISTORY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pretty) PRETTY=1; shift ;;
    --csv) CSV_FILE="${2:?--csv krever filnavn}"; shift 2 ;;
    --history) HISTORY=1; shift ;;
    --detail) DETAIL=1; shift ;;
    --ip) IP_FILTER="${2:?--ip krever en IP-adresse}"; shift 2 ;;
    --rules) RULES_DUMP=1; shift ;;
    *) echo "Ukjent flagg: $1" >&2; exit 1 ;;
  esac
done

# --- Steg 1: Last og valider credentials -------------------------------------
if [[ ! -f "$ENV_FILE" ]]; then
  echo "FEIL: Finner ikke $ENV_FILE" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"
# After `source`: an empty WAN_IF= from .env.example keeps the default.
WAN_IF="${WAN_IF:-igc1}"
# --history: the file comes from .env, so the workflow needs no path of its own (#466).
if [[ $HISTORY -eq 1 && -z "$CSV_FILE" ]]; then
  CSV_FILE="${FIREWALL_HISTORY_CSV:-$HOME/.opencode/MEMORY/STATE/firewall-history.csv}"
  mkdir -p "$(dirname "$CSV_FILE")"
fi

for var in OPNSENSE_API_URL OPNSENSE_API_KEY OPNSENSE_API_SECRET; do
  if [[ -z "${!var:-}" ]]; then
    echo "FEIL: $var mangler i $ENV_FILE" >&2
    exit 1
  fi
done

command -v jq >/dev/null || { echo "FEIL: jq er ikke installert" >&2; exit 1; }

# --- Hjelpefunksjon: GET med statuskodehåndtering ----------------------------
# Merk: sertifikat valideres alltid (ingen -k). Credentials logges aldri.
# Testene peker OPNSENSE_FIXTURES på en katalog med ett svar per sti:
# /api/core/firmware/status -> core_firmware_status.json. Mangler fila, er det 404.
fixture() {
  local f="${1#/api/}"; f="${f%%\?*}"; f="${f%/}"
  f="$OPNSENSE_FIXTURES/${f//\//_}.json"
  if [[ -f "$f" ]]; then cat "$f"; else printf 'null'; fi
}

api_get() {
  local path="$1"
  local out http
  [[ -n "${OPNSENSE_FIXTURES:-}" ]] && { fixture "$path"; return; }
  out=$(curl -s -m "$CURL_TIMEOUT" -w '\n%{http_code}' \
    -u "${OPNSENSE_API_KEY}:${OPNSENSE_API_SECRET}" \
    "${OPNSENSE_API_URL}${path}") || {
      echo "FEIL: Kan ikke nå OPNsense på ${OPNSENSE_API_URL}" >&2
      exit 3
    }
  http="${out##*$'\n'}"
  body="${out%$'\n'*}"
  case "$http" in
    200) printf '%s' "$body" ;;
    401|403) echo "FEIL: Autentiseringsfeil ($http) på $path — sjekk API-nøkler" >&2; exit 2 ;;
    404) printf 'null' ;;   # endpoint/plugin finnes ikke — håndteres nedstrøms
    *) echo "FEIL: HTTP $http på $path" >&2; exit 4 ;;
  esac
}

# Søk som OPNsense bare svarer på med POST. Ingen andre stier slipper gjennom.
api_post() {
  local path="$1"
  local payload="$2"
  local out http
  case "$path" in
    /api/ids/service/queryAlerts) ;;
    *) echo "FEIL: api_post nekter $path — bare /api/ids/service/queryAlerts er tillatt" >&2; exit 4 ;;
  esac
  [[ -n "${OPNSENSE_FIXTURES:-}" ]] && { fixture "$path"; return; }
  out=$(curl -s -m "$CURL_TIMEOUT" -w '\n%{http_code}' \
    -X POST -H "Content-Type: application/json" -d "$payload" \
    -u "${OPNSENSE_API_KEY}:${OPNSENSE_API_SECRET}" \
    "${OPNSENSE_API_URL}${path}") || {
      echo "FEIL: Kan ikke nå OPNsense på ${OPNSENSE_API_URL}" >&2
      exit 3
    }
  http="${out##*$'\n'}"
  body="${out%$'\n'*}"
  case "$http" in
    200) printf '%s' "$body" ;;
    401|403) echo "FEIL: Autentiseringsfeil ($http) på $path — sjekk API-nøkler" >&2; exit 2 ;;
    404) printf 'null' ;;
    *) echo "FEIL: HTTP $http på $path" >&2; exit 4 ;;
  esac
}

# --- Steg 2: Hent rådata (KUN GET, unntatt queryAlerts) -------------------------
# Råsvar skrives til temp-filer og leses med --slurpfile. Dette unngår
# «Argument list too long» for store loggvinduer (LOG_LIMIT > ~100).
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

api_get "/api/core/system/status"                  > "$TMPDIR/sys.json"
api_get "/api/core/firmware/status"                > "$TMPDIR/fw.json"
api_get "/api/diagnostics/firewall/log/?limit=${LOG_LIMIT}" > "$TMPDIR/flog.json"
api_get "/api/firewall/filter/searchRule"          > "$TMPDIR/rules.json"
api_get "/api/crowdsec/service/status"             > "$TMPDIR/cs_svc.json"
api_get "/api/crowdsec/general/get"                > "$TMPDIR/cs_gen.json"
api_get "/api/crowdsec/alerts/search"              > "$TMPDIR/cs_alerts.json"
api_get "/api/crowdsec/decisions/search"           > "$TMPDIR/cs_dec.json"
api_get "/api/crowdsec/bouncers/search"            > "$TMPDIR/cs_bnc.json"
api_get "/api/ids/service/status"                  > "$TMPDIR/ids_svc.json"
api_get "/api/ids/settings/get"                    > "$TMPDIR/ids_set.json"
api_post "/api/ids/service/queryAlerts" "{\"current\":1,\"rowCount\":${IDS_LIMIT}}" > "$TMPDIR/ids_alerts.json"

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# --- Steg 3: Aggreger alt med jq ----------------------------------------------
# All telling, topplister og vurderingslogikk skjer her — deterministisk.
RESULT=$(jq -n \
  --arg ts "$TIMESTAMP" \
  --arg wan_if "$WAN_IF" \
  --argjson log_limit "$LOG_LIMIT" \
  --slurpfile sys "$TMPDIR/sys.json" \
  --slurpfile fw "$TMPDIR/fw.json" \
  --slurpfile flog "$TMPDIR/flog.json" \
  --slurpfile rules "$TMPDIR/rules.json" \
  --slurpfile cs_svc "$TMPDIR/cs_svc.json" \
  --slurpfile cs_gen "$TMPDIR/cs_gen.json" \
  --slurpfile cs_alerts "$TMPDIR/cs_alerts.json" \
  --slurpfile cs_dec "$TMPDIR/cs_dec.json" \
  --slurpfile cs_bnc "$TMPDIR/cs_bnc.json" \
  --slurpfile ids_svc "$TMPDIR/ids_svc.json" \
  --slurpfile ids_set "$TMPDIR/ids_set.json" \
  --slurpfile ids_alerts "$TMPDIR/ids_alerts.json" \
  --argjson ids_limit "$IDS_LIMIT" \
  --arg verified "$VERIFIED" \
  --argjson detail "$DETAIL" \
  --argjson rules_dump "$RULES_DUMP" \
  --arg ip_filter "$IP_FILTER" \
'
# Hjelpefunksjon: topp-N frekvenstelling -> [[verdi, antall], ...]
def topn(n): map(select(. != null and . != "")) | group_by(.) | map([.[0], length]) | sort_by(-.[1]) | .[:n];
# OPNsense option fields: {key: {value, selected}} -> the selected entries.
def selected: (. // {}) | to_entries | map(select(.value.selected == 1));

# --slurpfile gir ett-elementers arrayer; pakk ut råverdiene.
($sys[0]) as $sys
| ($fw[0]) as $fw
| ($flog[0]) as $flog
| ($rules[0]) as $rules
| ($cs_svc[0]) as $cs_svc
| ($cs_gen[0]) as $cs_gen
| ($cs_alerts[0]) as $cs_alerts
| ($cs_dec[0]) as $cs_dec
| ($cs_bnc[0]) as $cs_bnc
| ($ids_svc[0]) as $ids_svc
| ($ids_set[0]) as $ids_set
| ($ids_alerts[0]) as $ids_alerts
| ($flog // []) as $log
| ($log | map(select(.action == "block"))) as $blocks
| ($rules.rows // []) as $rows
| {
  checked_utc: $ts,
  log_limit: $log_limit,

  system: ({
    version: ($fw.product.product_version // $fw.product_version // "ukjent"),
    nickname: ($fw.product.product_nickname // $fw.product_nickname // ""),
    arch: ($fw.product.product_arch // $fw.product_arch // ""),
    latest: ($fw.product.product_latest // $fw.product_latest // ""),
    update_available: (
      (($fw.product.product_version // $fw.product_version // "") | sub("_.*$"; "")) as $v
      | ($fw.product.product_latest // $fw.product_latest // "") as $l
      | ($l != "" and $v != $l)
    ),
    status_message: ($sys.metadata.system.message // "")
  }
  # Hvilken serie og utgave brannmuren kjører, mot det endepunktene er verifisert på (#414).
  # Utgaven fra product_id: opnsense = CE, opnsense-business = BE; serien fra
  # product_series, ellers major.minor av versjonen.
  | (($fw.product.product_series // "") as $ps
     | if $ps != "" then $ps
       else ($fw.product.product_version // $fw.product_version // "") | capture("^(?<s>[0-9]+\\.[0-9]+)").s? // ""
       end) as $series
  | (($fw.product.product_id // "") as $id
     | if $id == "opnsense" then "CE" elif $id == "opnsense-business" then "BE"
       elif $id == "" then "ukjent" else $id end) as $edition
  | . + {
    series: $series,
    edition: $edition,
    verified: (($verified | split(" ") | map(select(. != ""))) as $list
      | ($list | index("\($series)/\($edition)") != null) as $ok
      | {
        list: $list,
        matches: $ok,
        note: (if $ok then ""
               else "endepunktene er verifisert på \($list | join(", ")), brannmuren kjører \($series)/\($edition) — verifiser på nytt (OpnSenseApi.md)"
               end)
      })
  }),

  inspection: {
    blocks: ($log | map(select(.action == "block")) | length),
    passes: ($log | map(select(.action == "pass")) | length),
    rejects: ($log | map(select(.action == "reject")) | length),
    wan_if: $wan_if,
    wan_blocks_in: ($log | map(select(.action == "block" and .interface == $wan_if and .dir == "in")) | length),
    top_blocked_src: ($blocks | map(.src) | topn(3)),
    top_blocked_dstport: ($blocks | map(.dstport // empty | tostring) | topn(3)),
    window_first: ($log | map(.__timestamp__) | min),
    window_last: ($log | map(.__timestamp__) | max),
    last_block: (($blocks | sort_by(.__timestamp__) | last) as $b
      | if $b then {ts: $b.__timestamp__, src: $b.src, dst: $b.dst, label: $b.label} else null end),
    assessment: (
      if ($log | map(select(.action == "block" and .interface == $wan_if and .dir == "in")) | length) >= 1
      then "AKTIV"
      else "ADVARSEL"
      end)
  },

  rules: ({
    total: ($rows | length),
    crowdsec: ($rows | map(select(
      ((.description // "") | test("crowdsec"; "i")) or
      ((.source_net // "") | test("crowdsec")) )) | length),
    enabled: ($rows | map(select(.enabled == "1")) | length),
    disabled: ($rows | map(select(.enabled != "1")) | length),
    custom: ($rows | map(select(.legacy != true)) | length),
    custom_top5: ($rows | map(select(.legacy != true))
      | .[:5]
      | map({description: (.description // ""), interface: (.interface // ""),
             action: (.action // ""), direction: (.direction // "")}))
  }
  + (if $rules_dump == 1 then {
      all_custom: ($rows | map(select(.legacy != true))
        | map({description: (.description // ""), interface: (.interface // ""),
               action: (.action // ""), direction: (.direction // ""),
               enabled: (.enabled // ""), src: (.source_net // ""), dst: (.destination_net // ""),
               dstport: (.destination_port // "")}))
    } else {} end)),

  crowdsec: (
    if $cs_svc == null and $cs_gen == null then
      {installed: false, assessment: "IKKE INSTALLERT"}
    else
      (($cs_gen.general // {}) as $g
      | ($cs_alerts.rows // []) as $alerts
      | {
        installed: true,
        service: ($cs_svc.status // "ukjent"),
        agent_enabled: ($g.agent_enabled == "1"),
        lapi_enabled: ($g.lapi_enabled == "1"),
        bouncer_enabled: ($g.firewall_bouncer_enabled == "1"),
        bouncers_connected: ($cs_bnc.rows // [] | length),
         alerts_total: ($alerts | length),
         active_bans: ($cs_dec.rows // [] | length)
       }
       + if $detail == 1 then {
         decisions: ($cs_dec.rows // [] | map({
           ip: (.scope_value // "" | sub("^Ip:"; "")),
           reason: (.reason // ""),
           action: (.action // ""),
           expiration: (.expiration // ""),
           country: (.country // ""),
           events: (.events_count // 0)
         }))
       } else {} end
       + {
         top_scenarios: ($alerts | map(.reason // empty) | topn(3)),
        top_countries: ($alerts | map(.country // empty) | topn(3)),
        recent_alerts: ($alerts | sort_by(.id) | reverse | .[:5]
          | map({id, ip: (.value // "" | sub("^Ip:"; "")), scenario: (.reason // ""),
                 country: (.country // ""), decisions: (.decisions // "")})),
        assessment: (
          ($g.agent_enabled == "1" and $g.lapi_enabled == "1"
           and $g.firewall_bouncer_enabled == "1"
           and ($cs_svc.status // "") == "running")
          as $all_ok
          | if $all_ok then "AKTIV" else "DELVIS" end)
      })
    end),

  suricata: (
    if $ids_svc == null then
      {installed: false, assessment: "IKKE INSTALLERT"}
    else
      (($ids_set.ids.general // {}) as $g
      | ($ids_alerts.rows // []) as $alerts
      | {
        installed: true,
        service: ($ids_svc.status // "ukjent"),
        running: (($ids_svc.status // "") == "running"),
        enabled: ($g.enabled == "1"),
        mode: ($g.mode | selected | map(.value.value) | first // ""),
        pattern_matcher: ($g.MPMAlgo | selected | map(.key) | first // ""),
        interfaces_monitored: ($g.interfaces | selected | map(.value.value)),
        alerts_window: $ids_limit,
        alert_count: ($alerts | length),
        last_alert_ts: ($alerts | map(.timestamp // empty) | max),
        top_signatures: ($alerts | map(.alert // empty) | topn(5)),
        notable_alerts: ($alerts
          | map(select((.alert // "") | test("TROJAN|MALWARE|EXPLOIT|C2|C&C"; "i")))
          | .[:5]
          | map({ts: (.timestamp // ""), alert: (.alert // ""), src_ip: (.src_ip // ""), dest_ip: (.dest_ip // "")})),
        assessment: (
          if ($ids_svc.status // "") != "running" then "STOPPET"
          elif ($alerts | length) == 0 then "KJØRER (ingen alerts enda)"
          else "AKTIV"
          end)
      })
    end),

  filtered: (
    if $ip_filter == "" then null
    else
      ($log | map(select(.src == $ip_filter or .dst == $ip_filter))) as $m
      | {
        ip: $ip_filter,
        window: $log_limit,
        total: ($m | length),
        blocks: ($m | map(select(.action == "block")) | length),
        passes: ($m | map(select(.action == "pass")) | length),
        rejects: ($m | map(select(.action == "reject")) | length),
        inbound: ($m | map(select(.dir == "in")) | length),
        outbound: ($m | map(select(.dir == "out")) | length),
        as_src: ($m | map(select(.src == $ip_filter)) | length),
        as_dst: ($m | map(select(.dst == $ip_filter)) | length),
        by_label: ($m | map(.label // "uten label") | topn(10)),
        entries: ($m | sort_by(.__timestamp__) | reverse | .[:25]
          | map({ts: .__timestamp__, action, dir, interface,
                 src, srcport, dst, dstport, proto: .protoname, label}))
      }
    end),

  overall: "beregnes_nedenfor"
}
| .overall = (
    if .inspection.assessment == "AKTIV"
       and (.crowdsec.assessment == "AKTIV" or .crowdsec.assessment == "IKKE INSTALLERT")
       and (.suricata.assessment == "AKTIV" or .suricata.assessment == "IKKE INSTALLERT")
       and .system.verified.matches
    then "OK"
    else "ADVARSEL"
    end)
')

# --- Steg 4: Les forrige rad i CSV-en FØR vi appender en ny (for delta) --------
# Uten --csv, med en ny fil, eller en fil med bare header: ingen forrige rad å
# sammenligne med. .delta blir da null — ikke feil, ikke utelatt. #223
PREV_ROW_JSON="null"
if [[ -n "$CSV_FILE" && -f "$CSV_FILE" ]]; then
  DATA_LINES=$(( $(wc -l < "$CSV_FILE") - 1 ))
  if [[ "$DATA_LINES" -ge 1 ]]; then
    LAST_ROW=$(tail -n 1 "$CSV_FILE")
    # Robust CSV-parsing: del på komma utenfor anførselstegn (strengfelt er
    # anførselstegn-kvotert av @csv, tall/bool er ukvotert), fjern de
    # omsluttende anførselstegnene og avdobl "" til " i strengfelt.
    PREV_ROW_JSON=$(printf '%s' "$LAST_ROW" | jq -cR '
      [splits(",(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)")]
      | map(if test("^\".*\"$") then .[1:-1] | gsub("\"\""; "\"") else . end)
    ')
  fi
fi

# --- Steg 5: Legg delta mot forrige rad inn i resultatet -----------------------
# Deterministisk i jq, ikke regnet om av modellen (samme designprinsipp som
# resten av scriptet). cs_alerts_total er med i delta, men ALDRI i .delta.changed:
# den teller rader /api/crowdsec/alerts/search returnerer nå, ikke en kumulativ
# teller, så et fall er ikke nødvendigvis et problem (#223).
# En forrige rad som ikke kan leses (avkortet, tomme felt) gir også null: historikken
# skal aldri kunne velte selve statusrapporten.
RESULT=$(echo "$RESULT" | jq --argjson prev "$PREV_ROW_JSON" --arg history_file "$CSV_FILE" '
  . as $r
  | . + {
    # Where the history lies, so the workflow can archive next to it (#466).
    history_file: (if $history_file == "" then null else $history_file end),
    delta: (try (
      if $prev == null then null
      else
        {
          previous_checked_utc: $prev[0],
          version: {previous: $prev[2], current: $r.system.version, changed: ($prev[2] != $r.system.version)},
          rules_total: (($prev[11] | tonumber) as $p | {previous: $p, current: $r.rules.total, changed: ($p != $r.rules.total), diff: ($r.rules.total - $p)}),
          cs_active_bans: (($prev[10] | tonumber) as $p | ($r.crowdsec.active_bans // 0) as $c | {previous: $p, current: $c, changed: ($p != $c), diff: ($c - $p)}),
          overall: {previous: $prev[1], current: $r.overall, changed: ($prev[1] != $r.overall)},
          cs_alerts_total: (($prev[9] | tonumber) as $p | ($r.crowdsec.alerts_total // 0) as $c | {previous: $p, current: $c, changed: ($p != $c), diff: ($c - $p)})
        } as $d
        | $d + {
            changed: ([
              (if $d.version.changed then "version" else empty end),
              (if $d.rules_total.changed then "rules_total" else empty end),
              (if $d.cs_active_bans.changed then "cs_active_bans" else empty end),
              (if $d.overall.changed then "overall" else empty end)
            ])
          }
      end
    ) catch null)
  }
')

# --- Steg 6 (valgfritt): Append historikkrad til CSV ---------------------------
# Selve formatet og radens innhold er uendret av delta over.
if [[ -n "$CSV_FILE" ]]; then
  if [[ ! -f "$CSV_FILE" ]]; then
    echo "checked_utc,overall,version,update_available,blocks,passes,rejects,wan_blocks_in,cs_assessment,cs_alerts_total,cs_active_bans,rules_total" > "$CSV_FILE"
  fi
  echo "$RESULT" | jq -r '[
    .checked_utc, .overall, .system.version, .system.update_available,
    .inspection.blocks, .inspection.passes, .inspection.rejects, .inspection.wan_blocks_in,
    .crowdsec.assessment, (.crowdsec.alerts_total // 0), (.crowdsec.active_bans // 0),
    .rules.total
  ] | @csv' >> "$CSV_FILE"
fi

# --- Steg 7: Output -------------------------------------------------------------
if [[ $PRETTY -eq 1 ]]; then
  echo "$RESULT" | jq .
else
  echo "$RESULT" | jq -c .
fi
