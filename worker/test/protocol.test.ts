// Byte-identity tests against the Express reference (../src), which was verified on a real
// SenseFace 2A, plus golden values taken from that device's logs.
// @ts-ignore -- tsconfig only has workers types; vitest runs this file under Node.
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import * as fmt from "../src/protocol/format";
import * as cmd from "../src/protocol/commands";
import { formatOffset, isValidTimeZone, localToUtcIso, nowLocal, offsetMinutes } from "../src/lib/time";
import { HttpError } from "../src/types";

const requireRef = createRequire("/Users/soikat/code/zkteco-microservice/worker/package.json");
const ref = requireRef("/Users/soikat/code/zkteco-microservice/src/helpers.js");
const refCmd = requireRef("/Users/soikat/code/zkteco-microservice/src/commands.js");

const SN = "NYU7254701889";

// Real registry body from the SenseFace 2A (firmware ZAM70-NF24HA-Ver3.3.12).
const REGISTRY_BODY =
  "DeviceType=acc,~DeviceName=SenseFace 2A,FirmVer=ZAM70-NF24HA-Ver3.3.12,PushVersion=Ver 3.1.2S-20250616,CommType=ethernet,MaxPackageSize=2048000,LockCount=1,ReaderCount=2,AuxInCount=1,AuxOutCount=0,MachineType=101,~IsOnlyRFMachine=0,~MaxUserCount=30,~MaxAttLogCount=15,~MaxUserFingerCount=10,MThreshold=35,IPAddress=192.168.10.2,GATEIPAddress=192.168.10.1,NetMask=255.255.255.0,~ZKFPVersion=13,IclockSvrFun=1,OverallAntiFunOn=0,~REXInputFunOn=0,~CardFormatFunOn=0,~SupAuthrizeFunOn=0,~ReaderCFGFunOn=0,~ReaderLinkageFunOn=0,~RelayStateFunOn=1,~Ext485ReaderFunOn=0,~TimeAPBFunOn=0,~CtlAllRelayFunOn=0,~LossCardFunOn=0,SimpleEventType=1,VerifyStyles=ffff1f00,EventTypes=FF0FF03DBA26018033060000F00000000000000000000000007703F007860100,NewNormalEventTypes=,NewErrorEventTypes=,NewWarningEventTypes=,DisableUserFunOn=0,DeleteAndFunOn=0,LogIDFunOn=1,DateFmtFunOn=0,DelAllLossCardFunOn=0,AutoClearDay=0,FirstDelayDay=0,DelayDay=0,StopAllVerify=0,FvFunOn=0,FaceFunOn=1,FingerFunOn=1,CameraOpen=1,SubcontractingUpgradeFunOn=1,UserPicURLFunOn=1,PhotoFunOn=1,~SerialNumber=NYU7254701889,IsSupportNFC=0,~MaxFingerCount=30,AccSupportFunList=001000001010100000000000000000000010001110100000000000000000000000000000000000000000000000000000,~DSTF=1,Reader1IOState=1,MultiCardInterTimeFunOn=1,MachineTZFunOn=1,BioPhotoFun=1,VisilightFun=1,~MaxFvCount=10,~MaxBioPhotoCount=1500,AutoServerFunOn=1,MultiBioDataSupport=0:1:0:0:0:0:0:0:0:1,MultiBioPhotoSupport=0:0:0:0:0:0:0:0:0:1,MultiBioVersion=0:13.0:0:0:0:0:0:0:0:40.1,MaxMultiBioPhotoCount=0:0:0:0:0:0:0:0:0:1500,MaxMultiBioDataCount=0:3000:0:0:0:0:0:0:0:1500,VisualIntercomFunOn=1,VideoProtocol=8,IsSupportQRcode=0,SipDeviceType=0,SipEnableUnit=1";

// Real rtlog/rtstate bodies: door and alarm events only (pin=0, event >= 100).
const RTLOG_DOOR_EVENTS =
  "time=2026-10-17 13:07:59\tpin=0\tcardno=0\teventaddr=1\tevent=206\tinoutstatus=2\tverifytype=200\tindex=10\tsitecode=0\tlinkid=0\tmaskflag=0\ttemperature=0\tconvtemperature=0\r\n" +
  "time=2026-10-17 13:07:59\tpin=0\tcardno=0\teventaddr=1\tevent=100\tinoutstatus=2\tverifytype=200\tindex=11\tsitecode=0\tlinkid=0\tmaskflag=0\ttemperature=0\tconvtemperature=0\r\n" +
  "time=2026-10-17 13:07:59\tpin=0\tcardno=0\teventaddr=1\tevent=102\tinoutstatus=2\tverifytype=200\tindex=12\tsitecode=0\tlinkid=0\tmaskflag=0\ttemperature=0\tconvtemperature=0\r\n";
const RTSTATE =
  "time=2026-10-17 13:07:59\tsensor=02\trelay=00\talarm=0200000000000000\tdoor=01\r\n" +
  "time=2026-10-17 13:07:59\tsensor=02\trelay=00\talarm=0100000000000000\tdoor=01\r\n";

// Same shape as the real lines, with successful verifications.
const RTLOG_PUNCHES =
  "time=2026-10-17 14:00:00\tpin=1\tcardno=0\teventaddr=1\tevent=0\tinoutstatus=0\tverifytype=15\tindex=20\tsitecode=0\tlinkid=0\tmaskflag=0\ttemperature=0\tconvtemperature=0\r\n" +
  "time=2026-10-17 18:30:05\tpin=42\tcardno=12345\teventaddr=1\tevent=1\tinoutstatus=1\tverifytype=4\tindex=21\tsitecode=0\tlinkid=0\tmaskflag=0\ttemperature=0\tconvtemperature=0\r\n" +
  "time=2026-10-17 18:31:00\tpin=7\tcardno=0\teventaddr=1\tevent=0\tinoutstatus=2\tverifytype=1\tindex=22\r\n" +
  "time=2026-10-17 18:32:00\tpin=8\tcardno=0\teventaddr=1\tevent=27\tinoutstatus=0\tverifytype=15\tindex=23\r\n";

const TRANSACTION_BODY =
  "transaction cardno=0\tpin=1\tverified=15\tdoorid=1\teventtype=0\tinoutstate=0\ttime_second=861178800\r\n" +
  "transaction cardno=0\tpin=2\tverified=25\tdoorid=1\teventtype=0\tinoutstate=1\ttime_second=861184044\r\n" +
  "transaction cardno=0\tpin=3\tverified=3\tdoorid=1\teventtype=0\tinoutstate=2\ttime_second=861184100\r\n" +
  "transaction cardno=0\tpin=0\tverified=200\tdoorid=1\teventtype=206\tinoutstate=2\ttime_second=861184200\r\n" +
  "transaction cardno=0\tpin=4\tverified=15\tdoorid=1\teventtype=27\tinoutstate=0\ttime_second=861184300\r\n" +
  "transaction cardno=0\tpin=5\tverified=15\tdoorid=1\teventtype=0\tinoutstate=0\ttime_second=0\r\n";

const ATTLOG_BODY =
  "1\t2026-10-17 09:01:22\t0\t15\t0\t0\t0\t\r\n" +
  "2\t2026-10-17 18:05:00\t1\t1\t0\t0\t0\t\r\n" +
  "3\t2026-10-17 18:06:00\t4\t2\r\n" +
  "4\t2026-10-17 18:07:00\t255\t15\r\n" +
  "OPLOG 4\t0\t2026-10-17 18:08:00\r\n" +
  "\r\n" +
  "5\t2026-10-17 18:09:00\r\n";

const USER_BODY =
  "user uid=1\tcardno=0\tpin=1\tpassword=1234\tgroup=0\tstarttime=0\tendtime=0\tname=Alice Rahman\tprivilege=14\tdisable=0\tverify=0\r\n" +
  "user uid=2\tcardno=998877\tpin=2\tpassword=\tgroup=0\tstarttime=0\tendtime=0\tname=Bob\tprivilege=0\tdisable=0\tverify=0\r\n" +
  "USER PIN=3\tName=Carol\tPri=0\tPasswd=\tCard=[0000000000]\tGrp=1\r\n" +
  "FP PIN=3\tFID=0\tSize=1000\tValid=1\tTMP=abc\r\n" +
  "user uid=4\tcardno=0\tpin=\tname=NoPin\r\n";

describe("format.ts byte-identity with helpers.js", () => {
  it("getConfig", () => {
    for (const offset of [6, 5.5, -4, 0, 5.75]) {
      expect(fmt.getConfig(SN, offset)).toBe(ref.getConfig({ query: { SN } }, offset));
    }
  });

  it("getRegistryCode", async () => {
    for (const sn of [SN, `session-${SN}`, "ABC123", ""]) {
      expect(await fmt.getRegistryCode(sn)).toBe(ref.getRegistryCode(sn));
    }
  });

  it("getAccConfig with requestDelay 2 equals the reference", async () => {
    for (const offset of [6, 5.5, -5]) {
      expect(await fmt.getAccConfig(SN, offset, 2)).toBe(ref.getAccConfig(SN, offset));
    }
    expect(await fmt.getAccConfig(SN, 6, 15)).toContain("\nRequestDelay=15\n");
  });

  it("encode/decodeDeviceSeconds", () => {
    const dates = ["2026-10-17T09:47:24Z", "2026-10-17T08:20:00Z", "2000-01-01T00:00:00Z", "2028-02-29T23:59:59Z", "2026-12-31T12:00:00Z"];
    for (const iso of dates) {
      const d = new Date(iso);
      expect(fmt.encodeDeviceSeconds(d)).toBe(ref.encodeDeviceSeconds(d));
    }
    for (const v of ["861184044", 861178800, "0", "-1", "abc", "123abc", "", 1e9]) {
      expect(fmt.decodeDeviceSeconds(v)).toBe(ref.decodeDeviceSeconds(v));
    }
    // Goldens from the device log (SET OPTIONS DateTime=861184044, acked with Return=0).
    expect(fmt.encodeDeviceSeconds(new Date("2026-10-17T09:47:24Z"))).toBe(861184044);
    expect(fmt.decodeDeviceSeconds("861184044")).toBe("2026-10-17 09:47:24");
    expect(fmt.decodeDeviceSeconds("861178800")).toBe("2026-10-17 08:20:00");
    expect(fmt.decodeDeviceSeconds("-1")).toBeNull();
    expect(fmt.decodeDeviceSeconds("abc")).toBeNull();
  });

  it("getDeviceTime", () => {
    const d = new Date("2026-10-17T09:47:24Z");
    for (const tz of ["+0600", "+0530", "-0400"]) {
      expect(fmt.getDeviceTime(d, tz)).toBe(ref.getDeviceTime(d, tz));
    }
    expect(fmt.getDeviceTime(d, "+0600")).toBe("DateTime=861184044,ServerTZ=+0600");
  });

  it("parseKeyValues on the real registry body and OPTIONS bodies", () => {
    const parsed = fmt.parseKeyValues(REGISTRY_BODY);
    expect(parsed).toEqual(ref.parseKeyValues(REGISTRY_BODY));
    expect(parsed.DeviceType).toBe("acc");
    expect(parsed["~DeviceName"]).toBe("SenseFace 2A");
    expect(parsed.NewNormalEventTypes).toBe("");
    expect(parsed.MultiBioVersion).toBe("0:13.0:0:0:0:0:0:0:0:40.1");
    expect(parsed["~SerialNumber"]).toBe(SN);
    for (const body of ["~DeviceName=X, with comma,FirmVer=1\r\nIPAddress=1.2.3.4\n", "", "  a=1 \n b=2 ", "novalue,x=1"]) {
      expect(fmt.parseKeyValues(body)).toEqual(ref.parseKeyValues(body));
    }
  });

  it("parseTabLine", () => {
    const lines = [
      ...USER_BODY.split("\n"),
      ...TRANSACTION_BODY.split("\n"),
      "time=2026-10-17 13:07:59\tpin=0\tevent=206\r",
      "",
      "noequals",
      "a b=c\td=e",
    ];
    for (const line of lines) expect(fmt.parseTabLine(line)).toEqual(ref.parseTabLine(line));
    expect(fmt.parseTabLine("USER PIN=3\tName=Carol")).toEqual({ table: "USER", fields: { pin: "3", name: "Carol" } });
  });

  it("toLines", () => {
    for (const body of [USER_BODY, ATTLOG_BODY, "", "\r\n\r\n"]) expect(fmt.toLines(body)).toEqual(ref.toLines(body));
  });
});

describe("format.ts parsers", () => {
  it("parseRealtimeLog ignores real door/alarm events and RTSTATE lines", () => {
    expect(fmt.parseRealtimeLog(RTLOG_DOOR_EVENTS)).toEqual([]);
    expect(fmt.parseRealtimeLog(RTSTATE)).toEqual([]);
  });

  it("parseRealtimeLog keeps the same punches as the reference, with direction and verifyMode", () => {
    const punches = fmt.parseRealtimeLog(RTLOG_PUNCHES);
    expect(punches.map(({ pin, punchedAt }) => ({ pin, punchedAt }))).toEqual(
      ref.parseRealtimeLog(RTLOG_PUNCHES, SN).map((p: { pin: string; activityTime: string }) => ({ pin: p.pin, punchedAt: p.activityTime }))
    );
    expect(punches).toEqual([
      { pin: "1", punchedAt: "2026-10-17 14:00:00", direction: "in", verifyMode: "face" },
      { pin: "42", punchedAt: "2026-10-17 18:30:05", direction: "out", verifyMode: "card" },
      { pin: "7", punchedAt: "2026-10-17 18:31:00", direction: null, verifyMode: "fingerprint" },
    ]);
  });

  it("parseTransactionLines", () => {
    const punches = fmt.parseTransactionLines(TRANSACTION_BODY);
    expect(punches.map(({ pin, punchedAt }) => ({ pin, punchedAt }))).toEqual(
      ref.parseTransactionLines(TRANSACTION_BODY, SN).map((p: { pin: string; activityTime: string }) => ({ pin: p.pin, punchedAt: p.activityTime }))
    );
    expect(punches).toEqual([
      { pin: "1", punchedAt: "2026-10-17 08:20:00", direction: "in", verifyMode: "face" },
      { pin: "2", punchedAt: "2026-10-17 09:47:24", direction: "out", verifyMode: "palm" },
      { pin: "3", punchedAt: "2026-10-17 09:48:20", direction: null, verifyMode: "password" },
    ]);
  });

  it("parseAttendanceLog", () => {
    const punches = fmt.parseAttendanceLog(ATTLOG_BODY);
    expect(punches.map(({ pin, punchedAt }) => ({ pin, punchedAt }))).toEqual(
      ref.parseAttendanceLog(ATTLOG_BODY, SN).map((p: { pin: string; activityTime: string }) => ({ pin: p.pin, punchedAt: p.activityTime }))
    );
    expect(punches).toEqual([
      { pin: "1", punchedAt: "2026-10-17 09:01:22", direction: "in", verifyMode: "face" },
      { pin: "2", punchedAt: "2026-10-17 18:05:00", direction: "out", verifyMode: "fingerprint" },
      { pin: "3", punchedAt: "2026-10-17 18:06:00", direction: null, verifyMode: "card" },
      { pin: "5", punchedAt: "2026-10-17 18:09:00", direction: null, verifyMode: "other" },
    ]);
  });

  it("parseUserLines matches the reference minus passwords", () => {
    const expected = ref
      .parseUserLines(USER_BODY)
      .map(({ password: _password, ...rest }: { password: string }) => rest);
    expect(fmt.parseUserLines(USER_BODY)).toEqual(expected);
    expect(fmt.parseUserLines(USER_BODY)).toEqual([
      { pin: "1", name: "Alice Rahman", cardNo: "0", privilege: 14 },
      { pin: "2", name: "Bob", cardNo: "998877", privilege: 0 },
      { pin: "3", name: "Carol", cardNo: "[0000000000]", privilege: 0 },
    ]);
    expect(fmt.parseUserLines("")).toEqual([]);
  });

  it("verifyModeOf", () => {
    const cases: [string | number | undefined, string][] = [
      [0, "password"], ["3", "password"], [1, "fingerprint"], ["2", "card"], [4, "card"],
      ["15", "face"], [25, "palm"], [200, "other"], [undefined, "other"], ["", "other"], ["x", "other"],
    ];
    for (const [code, mode] of cases) expect(fmt.verifyModeOf(code)).toBe(mode);
  });
});

// Calls the reference and the port; both must return the same lines or the same error message.
const same = (port: () => string[], reference: () => string[]) => {
  let expected: string[] | Error;
  try {
    expected = reference();
  } catch (e) {
    expected = e as Error;
  }
  if (expected instanceof Error) {
    let thrown: unknown;
    try {
      port();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).status).toBe(400);
    expect((thrown as HttpError).message).toBe(expected.message);
  } else {
    expect(port()).toEqual(expected);
  }
};

describe("commands.ts byte-identity with commands.js", () => {
  const types = ["acc", null, "att"];

  it("addUser", () => {
    const users = [
      { pin: "1", name: "Alice Rahman", cardNo: "998877", privilege: 14, password: "1234" },
      { pin: "2", name: "Tab\tName\r\n" },
      { pin: " 3 ", privilege: 0 },
      { pin: "" },
      { pin: "a b" },
      { pin: "a=b" },
      { pin: "4", privilege: -1 },
      { pin: "5", privilege: 1.5 },
    ];
    for (const t of types) for (const u of users) same(() => cmd.addUser(t, u), () => refCmd.addUser(t, u));
  });

  it("deleteUser", () => {
    for (const t of types) for (const pin of ["1", "007", "", "x y"]) same(() => cmd.deleteUser(t, pin), () => refCmd.deleteUser(t, pin));
  });

  it("queryUsers", () => {
    for (const t of types) expect(cmd.queryUsers(t)).toEqual(refCmd.queryUsers(t));
  });

  it("queryAttendance", () => {
    const ranges = [
      { from: "2026-10-01", to: "2026-10-17" },
      { from: "2026-01-15 08:00:00", to: "2026-03-02 17:30:00" },
      { from: "2025-12-01", to: "2026-01-31" },
      { from: "2025-11-01", to: "2026-10-31" },
      { from: "2025-10-01", to: "2026-10-31" },
      { from: "2026-10-17", to: "2026-10-01" },
      { from: "2026-10-17", to: "" },
      { from: "17/10/2026", to: "2026-10-18" },
    ];
    for (const t of types) for (const r of ranges) same(() => cmd.queryAttendance(t, r), () => refCmd.queryAttendance(t, r));
  });

  it("syncTime", () => {
    const at = new Date("2026-10-17T09:47:24Z");
    for (const t of types) same(() => cmd.syncTime(t, at), () => refCmd.syncTime(t, at));
    expect(cmd.syncTime("acc", at)).toEqual(["SET OPTIONS DateTime=861184044"]);
    same(() => cmd.syncTime("acc", new Date("nope")), () => refCmd.syncTime("acc", new Date("nope")));
  });

  it("openDoor", () => {
    for (const t of types) {
      for (const s of [undefined, 1, 5, 16, 254, 0, 255, 2.5]) same(() => cmd.openDoor(t, s), () => refCmd.openDoor(t, s));
    }
    expect(cmd.openDoor("acc")).toEqual(["CONTROL DEVICE 01010105"]);
  });

  it("reboot", () => {
    for (const t of types) expect(cmd.reboot(t)).toEqual(refCmd.reboot(t));
  });

  it("redact", () => {
    const commands = [
      ...cmd.addUser("acc", { pin: "1", name: "A", password: "1234" }),
      ...cmd.addUser(null, { pin: "1", name: "A", password: "secret" }),
      ...cmd.addUser("acc", { pin: "1", name: "A" }),
      "",
    ];
    for (const c of commands) expect(cmd.redact(c)).toBe(refCmd.redact(c));
    expect(cmd.redact(commands[0] ?? "")).toContain("Password=***\t");
  });
});

describe("time.ts", () => {
  const july = new Date("2026-07-01T12:00:00Z");
  const january = new Date("2026-01-15T12:00:00Z");

  it("offsetMinutes", () => {
    expect(offsetMinutes("Asia/Dhaka", july)).toBe(360);
    expect(offsetMinutes("Asia/Kolkata", july)).toBe(330);
    expect(offsetMinutes("Asia/Kathmandu", july)).toBe(345);
    expect(offsetMinutes("America/St_Johns", january)).toBe(-210);
    expect(offsetMinutes("America/New_York", july)).toBe(-240);
    expect(offsetMinutes("America/New_York", january)).toBe(-300);
    expect(offsetMinutes("UTC", july)).toBe(0);
    expect(offsetMinutes("Asia/Dhaka", new Date("2026-10-17T03:01:22.789Z"))).toBe(360);
  });

  it("formatOffset", () => {
    expect(formatOffset(360)).toBe("+0600");
    expect(formatOffset(330)).toBe("+0530");
    expect(formatOffset(-210)).toBe("-0330");
    expect(formatOffset(-240)).toBe("-0400");
    expect(formatOffset(0)).toBe("+0000");
    expect(formatOffset(345)).toBe("+0545");
  });

  it("localToUtcIso", () => {
    expect(localToUtcIso("2026-10-17 09:01:22", "Asia/Dhaka")).toBe("2026-10-17T03:01:22Z");
    expect(localToUtcIso("2026-10-17 09:00:00", "Asia/Kolkata")).toBe("2026-10-17T03:30:00Z");
    expect(localToUtcIso("2026-01-01 00:10:00", "Asia/Kolkata")).toBe("2025-12-31T18:40:00Z");
    expect(localToUtcIso("2026-07-01 08:00:00", "America/New_York")).toBe("2026-07-01T12:00:00Z");
    expect(localToUtcIso("2026-01-15 08:00:00", "America/New_York")).toBe("2026-01-15T13:00:00Z");
    // Just after the spring-forward and fall-back transitions.
    expect(localToUtcIso("2026-03-08 03:30:00", "America/New_York")).toBe("2026-03-08T07:30:00Z");
    expect(localToUtcIso("2026-11-01 02:30:00", "America/New_York")).toBe("2026-11-01T07:30:00Z");
    expect(localToUtcIso("2026-10-17 09:01:22", "UTC")).toBe("2026-10-17T09:01:22Z");
  });

  it("localToUtcIso is deterministic in DST gaps and overlaps", () => {
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
    const gap = localToUtcIso("2026-03-08 02:30:00", "America/New_York");
    const overlap = localToUtcIso("2026-11-01 01:30:00", "America/New_York");
    expect(gap).toMatch(iso);
    expect(overlap).toMatch(iso);
    expect(["2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z"]).toContain(overlap);
    expect(localToUtcIso("2026-03-08 02:30:00", "America/New_York")).toBe(gap);
  });

  it("localToUtcIso rejects bad input with HttpError(400)", () => {
    for (const [local, tz] of [
      ["2026-13-01 00:00:00", "Asia/Dhaka"],
      ["2026-02-30 00:00:00", "Asia/Dhaka"],
      ["2026-10-17 24:00:00", "Asia/Dhaka"],
      ["garbage", "Asia/Dhaka"],
      ["2026-10-17", "Asia/Dhaka"],
      ["2026-10-17 09:01:22", "Mars/Olympus"],
      ["2026-10-17 09:01:22", ""],
    ] as const) {
      expect(() => localToUtcIso(local, tz)).toThrow(HttpError);
    }
  });

  it("nowLocal", () => {
    const at = new Date("2026-10-17T03:01:22Z");
    expect(nowLocal("Asia/Dhaka", at)).toBe("2026-10-17 09:01:22");
    expect(nowLocal("Asia/Kolkata", at)).toBe("2026-10-17 08:31:22");
    expect(nowLocal("America/New_York", at)).toBe("2026-10-16 23:01:22");
    expect(nowLocal("UTC", new Date("2026-10-17T00:00:00Z"))).toBe("2026-10-17 00:00:00");
    expect(nowLocal("Asia/Dhaka")).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("round-trips nowLocal through localToUtcIso", () => {
    const at = new Date("2026-10-17T03:01:22Z");
    for (const tz of ["Asia/Dhaka", "Asia/Kolkata", "America/New_York", "Europe/London", "Australia/Adelaide"]) {
      expect(localToUtcIso(nowLocal(tz, at), tz)).toBe("2026-10-17T03:01:22Z");
    }
  });

  it("isValidTimeZone", () => {
    expect(isValidTimeZone("Asia/Dhaka")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });

  it("config TimeZone= matches the reference's utcOffset()/60 for fractional zones", () => {
    const hours = offsetMinutes("Asia/Kolkata", july) / 60;
    expect(fmt.getConfig(SN, hours)).toContain("\nTimeZone=5.5\n");
  });
});
