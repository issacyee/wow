/**
 * Cross-platform desktop notification provider.
 *
 * Uses host-native commands and parameterized spawn calls. Notification text
 * travels through arguments/environment variables, never an interpolated shell
 * command. The Windows backend also installs a per-user Start Menu identity so
 * Win32 toast banners have a stable AppUserModelID.
 */

import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import type { Notification, NotificationProvider, NotificationResult } from "./provider.ts";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_DIAGNOSTIC_LENGTH = 2_000;
export const WINDOWS_APP_ID = "EarendilWorks.Pi";
const WINDOWS_SHORTCUT_NAME = "Pi Notifications.lnk";
const WINDOWS_IDENTITY_SOURCE = `using System;
using System.Runtime.InteropServices;
using System.Text;
[StructLayout(LayoutKind.Sequential, Pack = 4)]
public struct PROPERTYKEY { public Guid fmtid; public uint pid; public PROPERTYKEY(Guid guid, uint id) { fmtid = guid; pid = id; } }
[StructLayout(LayoutKind.Explicit)]
public struct PROPVARIANT { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr value; }
[ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IShellLinkW { void GetPath(StringBuilder a,int b,IntPtr c,uint d); void GetIDList(out IntPtr a); void SetIDList(IntPtr a); void GetDescription(StringBuilder a,int b); void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string a); void GetWorkingDirectory(StringBuilder a,int b); void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string a); void GetArguments(StringBuilder a,int b); void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string a); void GetHotKey(out short a); void SetHotKey(short a); void GetShowCmd(out uint a); void SetShowCmd(uint a); void GetIconLocation(out StringBuilder a,int b,out int c); void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string a,int b); void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string a,uint b); void Resolve(IntPtr a,uint b); void SetPath([MarshalAs(UnmanagedType.LPWStr)] string a); }
[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPropertyStore { void GetCount(out uint a); void GetAt([In] uint a,[Out, MarshalAs(UnmanagedType.Struct)] out PROPERTYKEY b); void GetValue([In, MarshalAs(UnmanagedType.Struct)] ref PROPERTYKEY a,[Out, MarshalAs(UnmanagedType.Struct)] out PROPVARIANT b); void SetValue([In, MarshalAs(UnmanagedType.Struct)] ref PROPERTYKEY a,[In, MarshalAs(UnmanagedType.Struct)] ref PROPVARIANT b); void Commit(); }
[ComImport, Guid("0000010B-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPersistFile { void GetCurFile([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder a); void IsDirty(); void Load([MarshalAs(UnmanagedType.LPWStr)] string a,[MarshalAs(UnmanagedType.U4)] long b); void Save([MarshalAs(UnmanagedType.LPWStr)] string a,bool b); void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string a); }
[ComImport, Guid("00021401-0000-0000-C000-000000000046"), ClassInterface(ClassInterfaceType.None)]
public class ShellLink {}
public static class PiToastIdentity {
  [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT p);
  public static void Install(string shortcutPath, string appId) {
    try {
      var link = (IShellLinkW)new ShellLink();
      try { link.SetPath(Environment.ExpandEnvironmentVariables(@"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")); } catch (Exception ex) { throw new Exception("SetPath failed for " + Environment.ExpandEnvironmentVariables(@"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe") + ": " + ex, ex); }
      link.SetArguments("-NoLogo"); link.SetDescription("Pi desktop notifications");
      var store = (IPropertyStore)link; var key = new PROPERTYKEY(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 5); var value = new PROPVARIANT { vt = 31, value = Marshal.StringToCoTaskMemUni(appId) };
      try { store.SetValue(ref key, ref value); store.Commit(); } finally { PropVariantClear(ref value); }
      ((IPersistFile)link).Save(shortcutPath, true);
    } catch (Exception ex) { throw new Exception("PiToastIdentity.Install: " + ex.ToString(), ex); }
  }
}`;

const WINDOWS_TOAST_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  `$appId = '${WINDOWS_APP_ID}'`,
  `$shortcutName = '${WINDOWS_SHORTCUT_NAME}'`,
  "$programs = [Environment]::GetFolderPath('Programs')",
  "$shortcutPath = [IO.Path]::Combine($programs, $shortcutName)",
  "$registration = 'HKCU:\\Software\\Classes\\AppUserModelId\\' + $appId",
  "$identityReady = (Test-Path -LiteralPath $shortcutPath) -and (Test-Path -LiteralPath $registration)",
  "if (-not $identityReady) {",
  "  $source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:WOW_NOTIFICATION_IDENTITY_SOURCE))",
  "  Add-Type -TypeDefinition $source -Language CSharp",
  "  [IO.Directory]::CreateDirectory($programs) > $null",
  "  [PiToastIdentity]::Install($shortcutPath, $appId)",
  "  New-Item -Path $registration -Force > $null",
  "  New-ItemProperty -Path $registration -Name DisplayName -Value 'Pi' -PropertyType String -Force > $null",
  "}",
  "[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]",
  "[void][Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]",
  "[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]",
  "$xml = [Windows.Data.Xml.Dom.XmlDocument]::new()",
  "$xml.LoadXml('<toast><visual><binding template=\"ToastGeneric\"><text></text><text></text><text></text><text></text></binding></visual></toast>')",
  "$texts = $xml.GetElementsByTagName('text')",
  "$texts.Item(0).AppendChild($xml.CreateTextNode($env:WOW_NOTIFICATION_TITLE)) > $null",
  "$texts.Item(1).AppendChild($xml.CreateTextNode($env:WOW_NOTIFICATION_LINE_1)) > $null",
  "$texts.Item(2).AppendChild($xml.CreateTextNode($env:WOW_NOTIFICATION_LINE_2)) > $null",
  "$texts.Item(3).AppendChild($xml.CreateTextNode($env:WOW_NOTIFICATION_LINE_3)) > $null",
  "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
  "$toast.SuppressPopup = $false",
  "$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)",
  "$notifier.Show($toast)",
  "$identityReady = (Test-Path -LiteralPath $shortcutPath) -and (Test-Path -LiteralPath $registration)",
  "Write-Output ('WOW_DIAGNOSTIC appId=' + $appId)",
  "Write-Output ('WOW_DIAGNOSTIC identity=' + $(if ($identityReady) { 'registered' } else { 'missing' }))",
  "Write-Output ('WOW_DIAGNOSTIC popup=requested')",
  "Write-Output ('WOW_DIAGNOSTIC setting=' + [string]$notifier.Setting)",
].join("; ");

const MACOS_NOTIFICATION_SCRIPT = [
  "on run argv",
  "display notification (item 2 of argv) with title (item 1 of argv)",
  "end run",
].join("\n");

export type DesktopPlatform = "windows" | "wsl" | "macos" | "linux" | "unsupported";

export interface DesktopBackend {
  platform: DesktopPlatform;
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  label: string;
}

interface ProcessResult {
  ok: boolean;
  missing: boolean;
  timedOut: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

function normalizeDiagnostic(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_DIAGNOSTIC_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_DIAGNOSTIC_LENGTH)}…`;
}

function notificationLine(notification: Notification, index: number): string {
  return notification.lines[index] ?? "";
}

function windowsNotificationEnv(
  env: NodeJS.ProcessEnv,
  notification: Notification,
  wsl: boolean,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {
    ...env,
    WOW_NOTIFICATION_IDENTITY_SOURCE: Buffer.from(WINDOWS_IDENTITY_SOURCE, "utf8").toString("base64"),
    WOW_NOTIFICATION_TITLE: notification.title,
    WOW_NOTIFICATION_LINE_1: notificationLine(notification, 0),
    WOW_NOTIFICATION_LINE_2: notificationLine(notification, 1),
    WOW_NOTIFICATION_LINE_3: notificationLine(notification, 2),
  };
  if (!wsl) return next;

  const names = [
    "WOW_NOTIFICATION_IDENTITY_SOURCE",
    "WOW_NOTIFICATION_TITLE",
    "WOW_NOTIFICATION_LINE_1",
    "WOW_NOTIFICATION_LINE_2",
    "WOW_NOTIFICATION_LINE_3",
  ];
  const namePattern = new RegExp(`^(${names.join("|")})(/.*)?$`, "i");
  const entries = (env.WSLENV ?? "").split(":").filter(Boolean).filter((entry) => !namePattern.test(entry));
  next.WSLENV = [...entries, ...names.map((name) => `${name}/w`)].join(":");
  return next;
}

export function isWslEnvironment(
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  osRelease?: string,
): boolean {
  if (platform !== "linux") return false;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  try {
    const release = osRelease ?? readFileSync("/proc/sys/kernel/osrelease", "utf8");
    return /microsoft|wsl/i.test(release);
  } catch {
    return false;
  }
}

export function detectDesktopPlatform(
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  osRelease?: string,
): DesktopPlatform {
  if (platform === "win32") return "windows";
  if (isWslEnvironment(platform, env, osRelease)) return "wsl";
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  return "unsupported";
}

export function resolveDesktopBackend(
  notification: Notification,
  options?: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; osRelease?: string },
): DesktopBackend {
  const platform = detectDesktopPlatform(options?.platform, options?.env, options?.osRelease);
  const env = options?.env ?? process.env;
  const body = notification.lines.join("\n");

  switch (platform) {
    case "windows":
    case "wsl":
      return {
        platform,
        command: "powershell.exe",
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_TOAST_SCRIPT],
        env: windowsNotificationEnv(env, notification, platform === "wsl"),
        label: platform === "wsl" ? "Windows toast banner (WSL host)" : "Windows toast banner",
      };
    case "macos":
      return {
        platform,
        command: "osascript",
        args: ["-e", MACOS_NOTIFICATION_SCRIPT, "--", notification.title, body],
        label: "macOS Notification Center",
      };
    case "linux":
      return {
        platform,
        command: "notify-send",
        args: ["--app-name=Pi", "--", notification.title, body],
        label: "Linux notify-send",
      };
    default:
      return { platform, label: `Unsupported platform (${options?.platform ?? process.platform})` };
  }
}

async function runBackend(backend: DesktopBackend, timeoutMs: number): Promise<ProcessResult> {
  return await new Promise<ProcessResult>((resolve) => {
    if (!backend.command) {
      resolve({ ok: false, missing: true, timedOut: false, exitCode: 127, stdout: "", stderr: backend.label });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let child: ReturnType<typeof spawn> | undefined;
    const finish = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(result);
    };
    const timeoutId = setTimeout(() => {
      timedOut = true;
      if (child && !child.killed) child.kill(process.platform === "win32" ? undefined : "SIGTERM");
      finish({ ok: false, missing: false, timedOut: true, exitCode: 124, stdout, stderr });
    }, timeoutMs);

    try {
      child = spawn(backend.command, backend.args ?? [], {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: backend.env,
      });
    } catch (error: any) {
      finish({ ok: false, missing: error?.code === "ENOENT", timedOut, exitCode: 127, stdout, stderr: String(error?.message ?? error) });
      return;
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_DIAGNOSTIC_LENGTH) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_DIAGNOSTIC_LENGTH) stderr += chunk.toString("utf8");
    });
    child.on("error", (error: any) => {
      finish({ ok: false, missing: error?.code === "ENOENT", timedOut, exitCode: 127, stdout, stderr: String(error?.message ?? error) });
    });
    child.on("close", (code) => {
      const exitCode = code ?? (timedOut ? 124 : 1);
      finish({ ok: !timedOut && exitCode === 0, missing: false, timedOut, exitCode, stdout, stderr });
    });
  });
}

function parseDiagnostics(stdout: string): string[] | undefined {
  const diagnostics = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("WOW_DIAGNOSTIC "))
    .map((line) => line.slice("WOW_DIAGNOSTIC ".length));
  return diagnostics.length > 0 ? diagnostics : undefined;
}

export class DesktopNotificationProvider implements NotificationProvider {
  readonly id = "desktop";
  private readonly timeoutMs: number;

  constructor(timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  async send(notification: Notification): Promise<NotificationResult> {
    const backend = resolveDesktopBackend(notification);
    if (!backend.command) {
      return { ok: false, available: false, backend: backend.label, error: "Desktop notifications are not supported on this platform." };
    }

    const result = await runBackend(backend, this.timeoutMs);
    const diagnostics = parseDiagnostics(result.stdout);
    if (result.ok) return { ok: true, available: true, backend: backend.label, diagnostics };

    let error: string;
    if (result.missing) error = `${backend.command} was not found.`;
    else if (result.timedOut) error = `Notification command timed out after ${this.timeoutMs}ms.`;
    else {
      const detail = normalizeDiagnostic(result.stderr || result.stdout);
      error = detail ? `Notification command exited with code ${result.exitCode}: ${detail}` : `Notification command exited with code ${result.exitCode}.`;
    }
    return { ok: false, available: !result.missing, backend: backend.label, diagnostics, error };
  }
}
