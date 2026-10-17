#!/bin/bash
# End-to-end check of the Worker on `wrangler dev` (local only; never a real device or POS).
#   npx wrangler d1 migrations apply zkteco_adms --local
#   npx wrangler dev --port 8787 --test-scheduled &
#   test/e2e.sh
# Starts test/mock-pos.mjs on :9797, simulates a SenseFace 2A (Security PUSH) and a legacy
# attendance device, and drives the admin and tenant APIs. Device bodies are the real ones
# captured from a SenseFace 2A (ZAM70-NF24HA-Ver3.3.12); config replies are compared byte for
# byte with the Express reference helpers in ../src. Prints PASS/FAIL per check and a summary.
set -u
DIR=$(cd "$(dirname "$0")/.." && pwd)
REF=$(cd "$DIR/../src" && pwd)
W=${WORKER_URL:-http://localhost:8787}
POS=http://localhost:9797
T=$(mktemp -d)
PW=$(grep '^ADMIN_PASSWORD=' "$DIR/.dev.vars" | cut -d= -f2-)
RUN=$(date +%s)
ACC=E2EACC$RUN
ATT=E2EATT$RUN
BDEV=E2EB$RUN
POS_KEY=pos-key-$RUN
REQUEST_DELAY=15 # wrangler.toml [vars]; the Express reference hard-codes 2

PASSN=0
FAILN=0
ok() { PASSN=$((PASSN + 1)); echo "PASS $1"; }
bad() { FAILN=$((FAILN + 1)); echo "FAIL $1${2:+ -- $2}"; }
expect() { if [ "$2" == "$3" ]; then ok "$1"; else bad "$1" "got [$2] want [$3]"; fi; }
truthy() { if [ "$2" == "true" ]; then ok "$1"; else bad "$1" "${3:-got $2}"; fi; }

# HTTP helpers: set CODE and BODY (body also in $T/body, byte-exact).
call() { CODE=$(curl -s -o "$T/body" -w '%{http_code}' "$@"); BODY=$(cat "$T/body"); }
adm() { local m=$1 p=$2; shift 2; call -u "admin:$PW" -H 'Content-Type: application/json' -H "Origin: $W" -X "$m" "$W/api/admin$p" "$@"; }
api() { local k=$1 m=$2 p=$3; shift 3; call -H "Authorization: Bearer $k" -H 'Content-Type: application/json' -X "$m" "$W/api/v1$p" "$@"; }
dget() { call -A 'iClock Proxy/1.09' "$W$1"; }
dpost() { call -A 'iClock Proxy/1.09' -X POST "$W$1" --data-binary "$2"; }
js() { jq -r "$1" <<<"$BODY"; }

sql() { (cd "$DIR" && npx wrangler d1 execute zkteco_adms --local --json --command "$1" 2>/dev/null) | jq -c '.[0].results'; }
records() { curl -s "$POS/__records"; }
# Delivered punches (POS answered 200) for one device pin.
pos_punches() { records | jq -c --arg sn "$1" --arg pin "$2" '[.[] | select(.status == 200 and .body.punches) | .body.punches[] | select(.deviceSN == $sn and .devicePin == $pin)]'; }
pos_users() { records | jq -c --arg sn "$1" '[.[] | select(.status == 200 and .path == "/api/attendance-api/v1/device-users") | .body | select(.deviceSN == $sn)]'; }
# Poll until a shell condition holds (background deliveries run in waitUntil).
waitfor() { for _ in $(seq 1 40); do eval "$1" && return 0; sleep 0.25; done; return 1; }

# Times: device local wall clock (Asia/Dhaka) and the expected UTC.
lt() { node -e 'process.stdout.write(new Date(process.argv[1]*1000).toLocaleString("sv-SE",{timeZone:"Asia/Dhaka"}))' "$1"; }
ut() { node -e 'process.stdout.write(new Date(process.argv[1]*1000).toISOString().replace(".000Z","Z"))' "$1"; }
devsec() { node -e 'const [d,t]=process.argv[1].split(" ");const [y,m,dd]=d.split("-").map(Number);const [h,mi,s]=t.split(":").map(Number);process.stdout.write(String((((y-2000)*12*31+(m-1)*31+dd-1)*86400)+h*3600+mi*60+s))' "$1"; }
refjs() { node -e "const h=require('$REF/helpers.js'),c=require('$REF/commands.js');process.stdout.write(String($1))"; }

E=$(($(date +%s) - 120))
L1=$(lt $E); U1=$(ut $E)               # held punch (pin 7)
L2=$(lt $((E + 10))); U2=$(ut $((E + 10))) # live punch (pin 8)
L3=$(lt $((E + 20)))                     # att punch (pin 101)
L4=$(lt $((E + 30)))                     # retried punch (pin 102)
L5=$(lt $((E + 40)))                     # 4xx punch (tenant B)

curl -s -o /dev/null "$W/health" || { echo "Worker not reachable at $W"; exit 1; }
POS_KEY=$POS_KEY RECORD="$T/pos.json" node "$DIR/test/mock-pos.mjs" >"$T/pos.log" 2>&1 &
MOCK=$!
trap 'kill $MOCK 2>/dev/null; wait $MOCK 2>/dev/null; rm -rf "$T"' EXIT
waitfor 'curl -s -o /dev/null $POS/__records' || { echo "mock POS did not start"; exit 1; }

echo "=== admin auth and CSRF"
call "$W/api/admin/devices"; expect "admin API without auth -> 401" "$CODE" 401
call -u admin:wrong "$W/api/admin/devices"; expect "admin API wrong password -> 401" "$CODE" 401
call "$W/admin/login"; expect "login page public -> 200" "$CODE" 200
call "$W/admin/app.js"; expect "admin asset without auth -> 302 to login" "$CODE" 302
call -u "admin:$PW" "$W/admin/app.js"; expect "admin asset with auth -> 200" "$CODE" 200
call -u "admin:$PW" -X POST -H 'Content-Type: text/plain' -d x "$W/api/admin/tenants"; expect "non-JSON mutation -> 415" "$CODE" 415
call -u "admin:$PW" -X POST -H 'Content-Type: application/json' -H 'Origin: https://evil.example' -d '{"name":"x"}' "$W/api/admin/tenants"; expect "cross-origin mutation -> 403" "$CODE" 403
call -u "admin:$PW" -X POST -H 'Content-Type: application/json' -H 'Sec-Fetch-Site: cross-site' -d '{"name":"x"}' "$W/api/admin/tenants"; expect "Sec-Fetch-Site cross-site -> 403" "$CODE" 403

echo "=== tenants"
adm POST /tenants -d "{\"name\":\"Acme $RUN\",\"posApiUrl\":\"$POS/api/\",\"posKey\":\"$POS_KEY\",\"timezone\":\"Asia/Dhaka\"}"
expect "create tenant A -> 201" "$CODE" 201
TA=$(js .tenant.id); KA=$(js .apiKey)
truthy "tenant A API key format, POS key not returned" "$(js '(.apiKey | test("^adms_[A-Za-z0-9_-]{43}$")) and (.tenant.posKey == null) and (.tenant.posKeyEnc == null)')" "$BODY"
adm POST /tenants -d "{\"name\":\"Beta $RUN\",\"posApiUrl\":\"$POS/api\",\"posKey\":\"wrong-key\",\"timezone\":\"Asia/Dhaka\"}"
expect "create tenant B -> 201" "$CODE" 201
TB=$(js .tenant.id); KB=$(js .apiKey)
adm POST "/tenants/$TA/test"
truthy "test POS connection (tenant A) ok" "$(js '.ok == true and .status == 200')" "$BODY"
call "$W/api/v1/devices"; expect "tenant API without key -> 401" "$CODE" 401
api "adms_${RUN}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" GET /devices; expect "tenant API unknown key -> 401" "$CODE" 401

echo "=== SenseFace 2A (Security PUSH): unadmitted"
REGISTRY_BODY="DeviceType=acc,~DeviceName=SenseFace 2A,FirmVer=ZAM70-NF24HA-Ver3.3.12,PushVersion=Ver 3.1.2S-20250616,CommType=ethernet,MaxPackageSize=2048000,LockCount=1,ReaderCount=2,AuxInCount=1,AuxOutCount=0,MachineType=101,~IsOnlyRFMachine=0,~MaxUserCount=30,~MaxAttLogCount=15,~MaxUserFingerCount=10,MThreshold=35,IPAddress=192.168.10.2,GATEIPAddress=192.168.10.1,NetMask=255.255.255.0,~ZKFPVersion=13,IclockSvrFun=1,OverallAntiFunOn=0,~REXInputFunOn=0,~CardFormatFunOn=0,~SupAuthrizeFunOn=0,~ReaderCFGFunOn=0,~ReaderLinkageFunOn=0,~RelayStateFunOn=1,~Ext485ReaderFunOn=0,~TimeAPBFunOn=0,~CtlAllRelayFunOn=0,~LossCardFunOn=0,SimpleEventType=1,VerifyStyles=ffff1f00,EventTypes=FF0FF03DBA26018033060000F00000000000000000000000007703F007860100,NewNormalEventTypes=,NewErrorEventTypes=,NewWarningEventTypes=,DisableUserFunOn=0,DeleteAndFunOn=0,LogIDFunOn=1,DateFmtFunOn=0,DelAllLossCardFunOn=0,AutoClearDay=0,FirstDelayDay=0,DelayDay=0,StopAllVerify=0,FvFunOn=0,FaceFunOn=1,FingerFunOn=1,CameraOpen=1,SubcontractingUpgradeFunOn=1,UserPicURLFunOn=1,PhotoFunOn=1,~SerialNumber=$ACC,IsSupportNFC=0,~MaxFingerCount=30,AccSupportFunList=001000001010100000000000000000000010001110100000000000000000000000000000000000000000000000000000,~DSTF=1,Reader1IOState=1,MultiCardInterTimeFunOn=1,MachineTZFunOn=1,BioPhotoFun=1,VisilightFun=1,~MaxFvCount=10,~MaxBioPhotoCount=1500,AutoServerFunOn=1,MultiBioDataSupport=0:1:0:0:0:0:0:0:0:1,MultiBioPhotoSupport=0:0:0:0:0:0:0:0:0:1,MultiBioVersion=0:13.0:0:0:0:0:0:0:0:40.1,MaxMultiBioPhotoCount=0:0:0:0:0:0:0:0:0:1500,MaxMultiBioDataCount=0:3000:0:0:0:0:0:0:0:1500,VisualIntercomFunOn=1,VideoProtocol=8,IsSupportQRcode=0,SipDeviceType=0,SipEnableUnit=1"
dpost "/iclock/registry?SN=$ACC" "$REGISTRY_BODY"
expect "unadmitted registry -> Authentication failed" "$CODE $BODY" '200 {"message":"Authentication failed."}'
dget "/iclock/cdata?SN=$ACC&options=all&pushver=3.1.2&DeviceType=acc&PushOptionsFlag=1"
expect "unadmitted cdata -> Authentication failed" "$BODY" '{"message":"Authentication failed."}'
waitfor 'adm GET "/devices/$ACC"; [ "$CODE" == 200 ]'
expect "unknown SN recorded as pending" "$(js '.status + " " + (.tenantId // "none")')" "pending none"
dget "/iclock/ping?SN=%3Cimg%20src%3Dx%3E"
expect "bad SN -> Authentication failed" "$BODY" '{"message":"Authentication failed."}'

echo "=== SenseFace 2A: approved without tenant (held punches)"
adm PATCH "/devices/$ACC" -d '{"status":"approved"}'
expect "admin approves device -> 200" "$CODE" 200
dpost "/iclock/registry?SN=$ACC" "$REGISTRY_BODY"
refjs "'RegistryCode=' + h.getRegistryCode('$ACC')" >"$T/ref"
if cmp -s "$T/body" "$T/ref"; then ok "registry byte-exact vs Express"; else bad "registry byte-exact vs Express" "$BODY"; fi
dget "/iclock/push?SN=$ACC"
refjs "h.getAccConfig('$ACC', 6).replace('RequestDelay=2', 'RequestDelay=$REQUEST_DELAY')" >"$T/ref"
if cmp -s "$T/body" "$T/ref"; then ok "push byte-exact vs Express"; else bad "push byte-exact vs Express" "$(diff "$T/body" "$T/ref")"; fi
dget "/iclock/cdata?SN=$ACC&options=all&pushver=3.1.2&DeviceType=acc&PushOptionsFlag=1"
if cmp -s "$T/body" "$T/ref"; then ok "cdata GET DeviceType=acc byte-exact vs Express"; else bad "cdata GET DeviceType=acc byte-exact" "$(diff "$T/body" "$T/ref")"; fi
dget "/iclock/rtdata?SN=$ACC&type=time"
REFSEC=$(refjs "h.encodeDeviceSeconds(new Date())")
GOTSEC=$(sed -n 's/^DateTime=\([0-9]*\),ServerTZ=+0600$/\1/p' <<<"$BODY")
if [ -n "$GOTSEC" ] && [ $((GOTSEC - REFSEC)) -le 2 ] && [ $((REFSEC - GOTSEC)) -le 2 ]; then ok "rtdata time matches Express format and clock"; else bad "rtdata time" "$BODY vs $REFSEC"; fi
dget "/iclock/ping?SN=$ACC"; expect "ping -> OK" "$BODY" OK
dget "/iclock/getrequest?SN=$ACC"; expect "getrequest, nothing queued -> OK" "$BODY" OK
adm GET "/devices/$ACC"
expect "registry recorded type and firmware" "$(js '.deviceType + " " + .firmware')" "acc ZAM70-NF24HA-Ver3.3.12"
# Real door/alarm events from the device (event 206/100/102, pin 0): not attendance.
dpost "/iclock/cdata?SN=$ACC&table=rtlog" $'time=2026-10-17 13:07:59\tpin=0\tcardno=0\teventaddr=1\tevent=206\tinoutstatus=2\tverifytype=200\tindex=10\tsitecode=0\tlinkid=0\tmaskflag=0\ttemperature=0\tconvtemperature=0\r\n'
expect "real rtlog door event -> OK" "$BODY" OK
dpost "/iclock/cdata?SN=$ACC&table=rtlog" $'time=2026-10-17 14:12:09\tpin=0\tcardno=0\teventaddr=1\tevent=102\tinoutstatus=2\tverifytype=200\tindex=19\tsitecode=0\tlinkid=0\tmaskflag=0\ttemperature=0\tconvtemperature=0\r\n'
expect "real rtlog alarm event -> OK" "$BODY" OK
dpost "/iclock/cdata?SN=$ACC&table=rtstate" $'time=2026-10-17 14:14:53\tsensor=02\trelay=00\talarm=0300000000000000\tdoor=01\r\n'
expect "real rtstate -> OK" "$BODY" OK
expect "door/alarm events store no punches" "$(sql "SELECT COUNT(*) AS n FROM punches WHERE sn = '$ACC'" | jq '.[0].n')" 0
dpost "/iclock/cdata?SN=$ACC&table=rtlog" "time=$L1"$'\tpin=7\tcardno=0\teventaddr=1\tevent=0\tinoutstatus=0\tverifytype=15\tindex=20\tsitecode=0\tlinkid=0\tmaskflag=0\ttemperature=0\tconvtemperature=0\r\n'
expect "rtlog punch before claim -> OK" "$BODY" OK
expect "punch stored as held, no tenant" "$(sql "SELECT delivery_status || ' ' || IFNULL(tenant_id, 'none') AS s FROM punches WHERE sn = '$ACC'" | jq -r '.[0].s')" "held none"
dpost "/iclock/cdata?SN=$ACC&table=tabledata&tablename=user&count=2" $'user uid=1\tcardno=\tpin=7\tpassword=\tgroup=0\tname=Alice\tprivilege=0\r\nuser uid=2\tcardno=\tpin=5\tpassword=99\tgroup=0\tname=Gone\tprivilege=0\r\n'
expect "tabledata user before claim -> user=2" "$BODY" "user=2"

echo "=== SenseFace 2A: tenant A claims it"
api "$KA" POST /devices -d "{\"sn\":\"$ACC\",\"name\":\"Front door\",\"branchId\":3}"
expect "tenant A claims device -> 201" "$CODE" 201
expect "claimed device shape" "$(js '[.sn, .name, .branchId, .deviceType, .userCount] | map(tostring) | join(" ")')" "$ACC Front door 3 acc 2"
waitfor '[ "$(pos_punches $ACC 7 | jq length)" == 1 ]' && ok "held punch released and delivered to POS" || bad "held punch released and delivered to POS" "$(records | jq -c 'map(.status)')"
P=$(pos_punches $ACC 7 | jq -c '.[0]')
expect "punch payload" "$(jq -r '[.deviceSN, .deviceName, .branchId, .devicePin, .punchedAt, .timezone, .punchedAtUtc, .direction, .verifyMode, .source] | map(tostring) | join("|")' <<<"$P")" "$ACC|Front door|3|7|$L1|Asia/Dhaka|$U1|in|face|live"
truthy "punch eventId is a UUID" "$(jq '.eventId | test("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")' <<<"$P")"
api "$KB" POST /devices -d "{\"sn\":\"$ACC\",\"name\":\"Mine\",\"branchId\":1}"
expect "tenant B claims A's device -> 409" "$CODE" 409
api "$KB" GET "/devices/$ACC/users"; expect "tenant B cannot see A's device -> 404" "$CODE" 404
api "$KB" PATCH "/devices/$ACC" -d '{"name":"x"}'; expect "tenant B cannot edit A's device -> 404" "$CODE" 404
api "$KB" GET /devices; expect "tenant B device list excludes A's" "$(js "map(select(.sn == \"$ACC\")) | length")" 0
api "$KA" GET /devices; expect "tenant A device list includes it" "$(js "map(select(.sn == \"$ACC\")) | .[0].online")" true

echo "=== SenseFace 2A: live punches, dedupe, users webhook"
RT8="time=$L2"$'\tpin=8\tcardno=0\teventaddr=1\tevent=0\tinoutstatus=1\tverifytype=1\tindex=21\tsitecode=0\tlinkid=0\tmaskflag=0\ttemperature=0\tconvtemperature=0\r\n'
dpost "/iclock/cdata?SN=$ACC&table=rtlog" "$RT8"; expect "live rtlog punch -> OK" "$BODY" OK
waitfor '[ "$(pos_punches $ACC 8 | jq length)" -ge 1 ]' && ok "live punch delivered immediately" || bad "live punch delivered immediately"
expect "live punch out/fingerprint/UTC" "$(pos_punches $ACC 8 | jq -r '.[0] | [.direction, .verifyMode, .source, .punchedAtUtc] | join(" ")')" "out fingerprint live $U2"
dpost "/iclock/cdata?SN=$ACC&table=rtlog" "$RT8"; expect "duplicate rtlog upload -> OK" "$BODY" OK
expect "duplicate not stored twice" "$(sql "SELECT COUNT(*) AS n FROM punches WHERE sn = '$ACC' AND pin = '8'" | jq '.[0].n')" 1
dpost "/iclock/cdata?SN=$ACC&table=tabledata&tablename=user&count=1" $'user uid=1\tcardno=123\tpin=7\tpassword=\tgroup=0\tname=Alice B\tprivilege=14\r\n'
expect "tabledata user after claim -> user=1" "$BODY" "user=1"
waitfor '[ "$(pos_users $ACC | jq length)" -ge 1 ]' && ok "device-users webhook sent" || bad "device-users webhook sent" "$(records | jq -c 'map(.path)')"
expect "device-users partial payload" "$(pos_users $ACC | jq -c '.[0] | [.branchId, .complete, .users]')" '[3,false,[{"devicePin":"7","name":"Alice B","cardNo":"123","privilege":"admin"}]]'

echo "=== SenseFace 2A: fetch-users"
api "$KA" POST "/devices/$ACC/actions/fetch-users"; expect "fetch-users -> 202" "$CODE" 202
CU=$(js '.commands[0].id')
dget "/iclock/getrequest?SN=$ACC"
expect "getrequest delivers DATA QUERY user (real command)" "$BODY" "C:$CU:DATA QUERY tablename=user,fielddesc=*,filter=*"
api "$KA" GET "/commands/$CU"; expect "command is sent" "$(js .status)" sent
api "$KB" GET "/commands/$CU"; expect "tenant B cannot read A's command -> 404" "$CODE" 404
dpost "/iclock/querydata?SN=$ACC&type=tabledata&cmdid=$CU&tablename=user&count=2&packcnt=1&packidx=1" $'user uid=1\tcardno=123\tpin=7\tpassword=\tgroup=0\tname=Alice B\tprivilege=14\r\nuser uid=3\tcardno=\tpin=9\tpassword=1234\tgroup=0\tname=Bob\tprivilege=0\r\n'
expect "querydata user -> user=2" "$BODY" "user=2"
dpost "/iclock/devicecmd?SN=$ACC" "ID=$CU&Return=0&CMD=DATA QUERY"$'\n'
expect "devicecmd -> OK" "$BODY" OK
api "$KA" GET "/commands/$CU"
expect "fetch-users command success" "$(js '[.status, .returnCode, .result, .kind, .deviceSN] | map(tostring) | join("|")')" "success|0|2 users|fetch-users|$ACC"
api "$KA" GET "/devices/$ACC/users"
expect "device users pruned to the device's list" "$(js 'map(.devicePin + ":" + .privilege) | join(",")')" "7:admin,9:user"
waitfor '[ "$(pos_users $ACC | jq "map(select(.complete)) | length")" -ge 1 ]' && ok "complete device-users webhook sent" || bad "complete device-users webhook sent"
expect "complete device-users payload" "$(pos_users $ACC | jq -c 'map(select(.complete))[0].users | map(.devicePin)')" '["7","9"]'

echo "=== SenseFace 2A: fetch-attendance (history)"
api "$KA" POST "/devices/$ACC/actions/fetch-attendance" -d '{"from":"2026-10-01","to":"2026-10-17"}'
expect "fetch-attendance -> 202" "$CODE" 202
CT=$(js '.commands[0].id')
dget "/iclock/getrequest?SN=$ACC"
REFQ=$(refjs "c.queryAttendance('acc', {from: '2026-10-01', to: '2026-10-17'})[0]")
expect "getrequest delivers DATA QUERY transaction (= Express)" "$BODY" "C:$CT:$REFQ"
dget "/iclock/getrequest?SN=$ACC"; expect "nothing else sent while DATA QUERY is open" "$BODY" OK
TX="transaction cardno=0"$'\t'"pin=7"$'\t'"verified=15"$'\t'"doorid=1"$'\t'"eventtype=0"$'\t'"inoutstate=0"$'\t'"time_second=$(devsec "$L1")"$'\tindex=5\r\n'
TX+="transaction cardno=0"$'\tpin=10\tverified=4\tdoorid=1\teventtype=0\tinoutstate=1\ttime_second=861184044\tindex=6\r\n'
dpost "/iclock/querydata?SN=$ACC&type=tabledata&cmdid=$CT&tablename=transaction&count=2&packcnt=1&packidx=1" "$TX"
expect "querydata transaction -> transaction=2" "$BODY" "transaction=2"
dpost "/iclock/devicecmd?SN=$ACC" "ID=$CT&return=0&CMD=DATA QUERY"
api "$KA" GET "/commands/$CT"
expect "fetch-attendance success with summary" "$(js '.status + "|" + .result')" "success|2 attendance records (1 new)"
waitfor '[ "$(pos_punches $ACC 10 | jq length)" -ge 1 ]' && ok "history punch delivered" || bad "history punch delivered"
expect "history punch payload" "$(pos_punches $ACC 10 | jq -r '.[0] | [.punchedAt, .punchedAtUtc, .direction, .verifyMode, .source] | join("|")')" "2026-10-17 09:47:24|2026-10-17T03:47:24Z|out|card|history"
expect "history copy of a live punch not re-delivered" "$(pos_punches $ACC 7 | jq length)" 1

echo "=== SenseFace 2A: user commands, one per poll"
api "$KA" PUT "/devices/$ACC/users/42" -d '{"name":"Rahim","privilege":"admin","password":"1234"}'
expect "PUT user -> 202" "$CODE" 202
IDS=$(js '.commands | map(.id) | join(" ")')
truthy "202 body has no command text" "$(js '[.commands[] | has("command")] | any | not')"
api "$KA" DELETE "/devices/$ACC/users/9"; expect "DELETE user -> 202" "$CODE" 202
IDS="$IDS $(js '.commands | map(.id) | join(" ")')"
api "$KA" POST "/devices/$ACC/actions/open-door" -d '{"seconds":5}'; expect "open-door -> 202" "$CODE" 202
IDS="$IDS $(js '.commands | map(.id) | join(" ")')"
EXPECTED_CMDS=$(refjs "[...c.addUser('acc', {pin: '42', name: 'Rahim', privilege: 14, password: '1234'}), ...c.deleteUser('acc', '9'), ...c.openDoor('acc', 5)].join('\n')")
GOT_IDS=""; GOT_CMDS=""; ONE_LINE=true
for _ in $IDS; do
  dget "/iclock/getrequest?SN=$ACC"
  [ "$(printf '%s' "$BODY" | wc -l | tr -d ' ')" == 0 ] || ONE_LINE=false
  [ "$(tail -c 1 "$T/body" | od -An -c | tr -d ' ')" == '\n' ] || ONE_LINE=false
  ID=${BODY#C:}; ID=${ID%%:*}
  GOT_IDS="$GOT_IDS $ID"; GOT_CMDS="$GOT_CMDS${GOT_CMDS:+$'\n'}${BODY#C:*:}"
  dpost "/iclock/devicecmd?SN=$ACC" "ID=$ID&Return=0&CMD=DATA"$'\n'
done
expect "commands delivered in queue order" "${GOT_IDS# }" "$IDS"
truthy "exactly one C: line per poll" "$ONE_LINE"
expect "command text = Express builders" "$GOT_CMDS" "$EXPECTED_CMDS"
dget "/iclock/getrequest?SN=$ACC"; expect "queue drained -> OK" "$BODY" OK
ALL_OK=true
for id in $IDS; do api "$KA" GET "/commands/$id"; [ "$(js .status)" == success ] || ALL_OK=false; done
truthy "every user/door command success" "$ALL_OK"
api "$KA" GET "/devices/$ACC/users"
expect "local users after PUT/DELETE" "$(js 'map(.devicePin + ":" + .name + ":" + .privilege) | join(",")')" "7:Alice B:admin,42:Rahim:admin"
api "$KA" PUT "/devices/$ACC/users/abc" -d '{"name":"x"}'; expect "PUT non-numeric pin -> 400" "$CODE" 400
api "$KA" POST "/devices/$ACC/actions/open-door" -d '{"seconds":90}'; expect "open-door 90 s -> 400" "$CODE" 400

echo "=== legacy attendance device"
dget "/iclock/cdata?SN=$ATT&options=all"
expect "unadmitted att handshake -> Authentication failed" "$BODY" '{"message":"Authentication failed."}'
dpost "/iclock/cdata?SN=$ATT&table=ATTLOG" "101"$'\t'"$L3"$'\t0\t1\r\n'
expect "unadmitted ATTLOG rejected" "$BODY" '{"message":"Authentication failed."}'
waitfor 'adm GET "/devices/$ATT"; [ "$CODE" == 200 ]'
expect "att device pending" "$(js .status)" pending
expect "unadmitted ATTLOG not stored" "$(sql "SELECT COUNT(*) AS n FROM punches WHERE sn = '$ATT'" | jq '.[0].n')" 0
api "$KA" POST /devices -d "{\"sn\":\"$ATT\",\"name\":\"Back office\",\"branchId\":4}"
expect "tenant A claims att device -> 201" "$CODE" 201
dget "/iclock/cdata?SN=$ATT&options=all"
refjs "h.getConfig({query: {SN: '$ATT'}}, 6)" >"$T/ref"
if cmp -s "$T/body" "$T/ref"; then ok "att handshake byte-exact vs Express"; else bad "att handshake byte-exact" "$(diff "$T/body" "$T/ref")"; fi
ATTLOG="101"$'\t'"$L3"$'\t0\t1\r\n'
dpost "/iclock/cdata?SN=$ATT&table=ATTLOG" "$ATTLOG"; expect "ATTLOG -> OK:1" "$BODY" "OK:1"
waitfor '[ "$(pos_punches $ATT 101 | jq length)" -ge 1 ]' && ok "att punch delivered" || bad "att punch delivered"
expect "att punch payload" "$(pos_punches $ATT 101 | jq -r '.[0] | [.branchId, .deviceName, .direction, .verifyMode, .source] | map(tostring) | join("|")')" "4|Back office|in|fingerprint|live"
dpost "/iclock/cdata?SN=$ATT&table=ATTLOG" "$ATTLOG"; expect "duplicate ATTLOG -> OK:1" "$BODY" "OK:1"
expect "duplicate ATTLOG not stored twice" "$(sql "SELECT COUNT(*) AS n FROM punches WHERE sn = '$ATT'" | jq '.[0].n')" 1
dpost "/iclock/cdata?SN=$ATT&table=OPERLOG" $'USER PIN=101\tName=Bob\tPri=0\tPasswd=\tCard=\tGrp=1\r\n'
expect "OPERLOG user -> OK" "$BODY" OK
waitfor '[ "$(pos_users $ATT | jq length)" -ge 1 ]' && ok "att device-users webhook" || bad "att device-users webhook"
dget "/iclock/getrequest?SN=$ATT"; expect "att getrequest -> OK" "$BODY" OK
api "$KA" POST "/devices/$ATT/actions/reboot"; CR=$(js '.commands[0].id')
dget "/iclock/getrequest?SN=$ATT"; expect "att reboot command (= Express)" "$BODY" "C:$CR:$(refjs "c.reboot('att')[0]")"
dpost "/iclock/devicecmd?SN=$ACC" "ID=$CR&Return=0&CMD=REBOOT"
api "$KA" GET "/commands/$CR"; expect "devicecmd from another SN ignored" "$(js .status)" sent
dpost "/iclock/devicecmd?SN=$ATT" "ID=$CR&Return=-1001&CMD=REBOOT"
api "$KA" GET "/commands/$CR"; expect "negative Return -> failed" "$(js '.status + " " + (.returnCode|tostring)')" "failed -1001"

echo "=== POS outage: retry via cron"
curl -s -X POST "$POS/__fail?n=1" >/dev/null
dpost "/iclock/cdata?SN=$ATT&table=ATTLOG" "102"$'\t'"$L4"$'\t1\t15\r\n'; expect "ATTLOG during outage -> OK:1" "$BODY" "OK:1"
waitfor '[ "$(records | jq "map(select(.status == 500)) | length")" -ge 1 ]' && ok "POS 500 seen" || bad "POS 500 seen"
waitfor '[ "$(sql "SELECT attempts FROM punches WHERE sn = '"'$ATT'"' AND pin = '"'102'"' AND delivery_status = '"'pending'"' AND last_error IS NOT NULL" | jq ".[0].attempts")" == 1 ]' \
  && ok "punch pending for retry, attempts=1" || bad "punch pending for retry" "$(sql "SELECT delivery_status, attempts, last_error, next_attempt_at FROM punches WHERE sn = '$ATT' AND pin = '102'")"
sql "UPDATE punches SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE sn = '$ATT' AND pin = '102'" >/dev/null
curl -s "$W/__scheduled?cron=*+*+*+*+*" >/dev/null
waitfor '[ "$(pos_punches $ATT 102 | jq length)" -ge 1 ]' && ok "cron retried and delivered" || bad "cron retried and delivered"
expect "retried punch delivered, attempts=2" "$(sql "SELECT delivery_status || ' ' || attempts AS s FROM punches WHERE sn = '$ATT' AND pin = '102'" | jq -r '.[0].s')" "delivered 2"
expect "retried punch payload" "$(pos_punches $ATT 102 | jq -r '.[0] | .direction + " " + .verifyMode')" "out face"

echo "=== POS rejects (4xx): failed at once"
api "$KB" POST /devices -d "{\"sn\":\"$BDEV\",\"branchId\":null}"; expect "tenant B claims a new SN -> 201" "$CODE" 201
dpost "/iclock/cdata?SN=$BDEV&table=ATTLOG" "201"$'\t'"$L5"$'\t0\t1\r\n'; expect "tenant B ATTLOG -> OK:1" "$BODY" "OK:1"
waitfor '[ "$(sql "SELECT delivery_status FROM punches WHERE sn = '"'$BDEV'"'" | jq -r ".[0].delivery_status")" == failed ]' \
  && ok "401 from POS -> punch failed" || bad "401 from POS -> punch failed" "$(sql "SELECT delivery_status, attempts, last_error FROM punches WHERE sn = '$BDEV'")"

echo "=== POS request hygiene"
expect "every POS request carried the right X-Authorization (except tenant B)" "$(records | jq '[.[] | select(.auth == false)] | length')" 1
truthy "every POS request had a unique X-Adms-Delivery-Id and JSON body" "$(records | jq '(map(.deliveryId) | unique | length) == length and all(.[]; .contentType == "application/json")')"
expect "no punch delivered twice" "$(records | jq '[.[] | select(.status == 200 and .body.punches) | .body.punches[] | [.deviceSN, .devicePin, .punchedAt]] | group_by(.) | map(select(length > 1)) | length')" 0

echo "=== reconciliation API"
api "$KA" GET "/attendance?deviceSN=$ACC&limit=2"
expect "attendance page newest first" "$(js '.punches | map(.devicePin) | join(",")')" "8,7"
NC=$(js .nextCursor)
api "$KA" GET "/attendance?deviceSN=$ACC&limit=2&cursor=$NC"
expect "attendance second page" "$(js '.punches | map(.devicePin) | join(",")')" "10"
api "$KB" GET "/attendance?deviceSN=$ACC"; expect "tenant B sees none of A's punches" "$(js '.punches | length')" 0
api "$KA" POST /attendance/redeliver -d "{\"from\":\"$(cut -c1-10 <<<"$L1")\",\"to\":\"$(cut -c1-10 <<<"$L1")\",\"deviceSN\":\"$ACC\"}"
expect "redeliver queues 2 live punches (+ history if same day)" "$(js '.queued >= 2')" true
waitfor '[ "$(pos_punches $ACC 8 | jq length)" -ge 2 ]' && ok "redelivered with same eventId" || bad "redelivered"
expect "redelivery keeps eventId" "$(pos_punches $ACC 8 | jq -r 'map(.eventId) | unique | length')" 1

echo "=== cleanup"
api "$KA" DELETE "/devices/$ATT"; expect "tenant releases device -> 204" "$CODE" 204
dget "/iclock/getrequest?SN=$ATT"; expect "released device rejected" "$BODY" '{"message":"Authentication failed."}'
adm DELETE "/tenants/$TB"; expect "admin deletes tenant B" "$CODE" 204
adm GET "/devices/$BDEV"; expect "tenant B's device unassigned and pending" "$(js '(.tenantId // "none") + " " + .status')" "none pending"

echo "=== $PASSN passed, $FAILN failed"
[ "$FAILN" == 0 ]
