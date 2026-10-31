// Settings → Server: the home server's own controls, driven from the web UI.
// Where the phone reaches it (Tailscale Serve), which devices are paired, and
// the background service — everything that used to live in launcher scripts
// and terminal output. `pnpm repcoach install` opens this section directly.
import { useCallback, useEffect, useRef, useState } from "react";

import type { PairedDevice, PairingLink, PhoneAccessState, ServerStatus, ServiceStatus } from "@repcoach/contracts";

import { serverAdmin, serverAdminAvailable, ServerAdminError } from "../runtime/serverAccess.ts";

const POLL_MS = 10_000;
const FAST_POLL_MS = 1_500;
const HANDOVER_TIMEOUT_MS = 90_000;

type Load = { readonly status: "loading" } | { readonly status: "ready"; readonly server: ServerStatus } | { readonly status: "failed"; readonly reason: string };

/** A server restart in progress: wait for a different process to answer. */
type Handover = { readonly fromInstanceId: string; readonly startedAt: number; readonly why: string };

export function ServerSection() {
  if (!serverAdminAvailable()) return null;
  return <ServerSectionLive />;
}

function ServerSectionLive() {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [handover, setHandover] = useState<Handover | null>(null);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const sectionRef = useRef<HTMLElement>(null);

  const refresh = useCallback(async () => {
    try {
      const server = await serverAdmin.status();
      setLoad({ status: "ready", server });
      return server;
    } catch (cause) {
      setLoad((previous) =>
        // Keep showing the last good status while a restart is in flight.
        previous.status === "ready" && handover !== null
          ? previous
          : { status: "failed", reason: cause instanceof ServerAdminError ? cause.message : "the server didn't answer" },
      );
      return undefined;
    }
  }, [handover]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), handover !== null || pairingOpen ? FAST_POLL_MS : POLL_MS);
    return () => clearInterval(timer);
  }, [refresh, handover, pairingOpen]);

  // `pnpm repcoach install` lands on /settings#server.
  useEffect(() => {
    if (window.location.hash === "#server") sectionRef.current?.scrollIntoView({ block: "start" });
  }, []);

  // A handover ends when a different server process answers.
  useEffect(() => {
    if (handover === null || load.status !== "ready") return;
    if (load.server.identity.instanceId !== handover.fromInstanceId) {
      setHandover(null);
      setNotice(
        load.server.service.managed
          ? "The background service is running the server now. It starts when you log on and restarts if it stops."
          : "The server restarted.",
      );
    } else if (Date.now() - handover.startedAt > HANDOVER_TIMEOUT_MS) {
      setHandover(null);
      setNotice(
        `The server didn't come back after ${handover.why}.${
          load.server.service.logPath === null ? "" : ` Check ${load.server.service.logPath}.`
        }`,
      );
    }
  }, [handover, load]);

  const startHandover = (why: string) => {
    if (load.status !== "ready") return;
    setNotice(null);
    setHandover({ fromInstanceId: load.server.identity.instanceId, startedAt: Date.now(), why });
  };

  return (
    <section id="server" ref={sectionRef} className="mt-8 border-t border-border pt-4 pb-4">
      <h3 className="text-[1.0625rem] leading-snug font-semibold">Server</h3>
      <p className="mt-1 text-sm leading-snug text-text-muted">
        Your home server — where your data lives and the coach runs.
      </p>

      {load.status === "loading" && <p className="mt-3 text-sm text-text-muted">Checking the server…</p>}
      {load.status === "failed" && handover === null && (
        <p className="mt-3 text-sm text-danger">Could not read the server's status — {load.reason}.</p>
      )}
      {handover !== null && (
        <p className="mt-3 rounded-control bg-surface-sunken px-3 py-2 text-sm leading-snug" role="status">
          Restarting the server ({handover.why}) — this page reconnects by itself in a few seconds…
        </p>
      )}
      {notice !== null && (
        <p className="mt-3 rounded-control bg-confirm-quiet px-3 py-2 text-sm leading-snug text-confirm" role="status">
          {notice}
        </p>
      )}

      {load.status === "ready" && (
        <>
          <ServerSummary server={load.server} />
          <PhoneAccess state={load.server.phoneAccess} onChecked={() => void refresh()} />
          <BackgroundService
            service={load.server.service}
            busy={handover !== null}
            onHandover={startHandover}
            onChanged={(message) => {
              setNotice(message);
              void refresh();
            }}
          />
          <PairedDevices
            server={load.server}
            pairingOpen={pairingOpen}
            onPairingOpen={setPairingOpen}
            onChanged={() => void refresh()}
          />
        </>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- summary */

function ServerSummary({ server }: { readonly server: ServerStatus }) {
  return (
    <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm leading-snug">
      <dt className="text-text-muted">Status</dt>
      <dd>
        <span className="mr-1.5 inline-block size-2 rounded-full bg-confirm align-middle" aria-hidden />
        Running since {new Date(server.identity.startedAt).toLocaleString()}
      </dd>
      <dt className="text-text-muted">Build</dt>
      <dd className="font-numeric text-xs leading-5">{server.identity.buildRef.slice(0, 12)}</dd>
      <dt className="text-text-muted">Data</dt>
      <dd className="min-w-0 font-numeric text-xs leading-5 break-all">{server.dbPath}</dd>
    </dl>
  );
}

/* ----------------------------------------------------------- phone access */

function PhoneAccess({ state, onChecked }: { readonly state: PhoneAccessState; readonly onChecked: () => void }) {
  const [checking, setChecking] = useState(false);
  const checkNow = () => {
    setChecking(true);
    void serverAdmin.recheckPhoneAccess().finally(() => {
      setChecking(false);
      onChecked();
    });
  };

  return (
    <div className="mt-5">
      <h4 className="font-numeric text-[0.6875rem] tracking-widest text-text-muted uppercase">Phone access</h4>
      <PhoneAccessBody state={state} />
      {state.kind !== "serving" && state.kind !== "disabled" && (
        <button
          type="button"
          onClick={checkNow}
          disabled={checking || state.kind === "checking"}
          className="mt-2 rounded-control border border-border px-3 py-1.5 text-sm active:bg-surface-sunken disabled:opacity-40"
        >
          {checking ? "Checking…" : "Check again"}
        </button>
      )}
    </div>
  );
}

function PhoneAccessBody({ state }: { readonly state: PhoneAccessState }) {
  const muted = "mt-1 text-sm leading-snug text-text-muted";
  switch (state.kind) {
    case "checking":
      return <p className={muted}>Checking Tailscale…</p>;
    case "serving":
      return (
        <>
          <p className="mt-1 text-sm leading-snug">
            <span className="mr-1.5 inline-block size-2 rounded-full bg-confirm align-middle" aria-hidden />
            Open <CopyableUrl url={state.url} /> on your phone, then add it to your home screen.
          </p>
          <p className={muted}>Over HTTPS through Tailscale, so rest-timer alerts and the screen wake lock work.</p>
        </>
      );
    case "https-disabled":
      return (
        <>
          <p className="mt-1 text-sm leading-snug">
            One step left, and only you can do it: turn on <span className="font-semibold">HTTPS Certificates</span>{" "}
            for your tailnet.
          </p>
          <a
            href={state.adminUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-block rounded-control bg-confirm px-3 py-1.5 text-sm font-semibold text-canvas"
          >
            Open Tailscale DNS settings
          </a>
          <p className={muted}>
            Then this server publishes https://{state.magicDnsName}/ by itself — it checks again every minute.
          </p>
        </>
      );
    case "not-installed":
      return (
        <p className={muted}>
          Tailscale isn't installed on this computer. Install it here and on your phone, sign both in to the same
          account, and this server sets up the phone URL by itself.
        </p>
      );
    case "logged-out":
      return <p className={muted}>Tailscale is signed out on this computer. Sign in to it (or run tailscale up).</p>;
    case "not-running":
      return <p className={muted}>{state.detail}. Start Tailscale on this computer.</p>;
    case "taken":
      return <p className={muted}>{state.detail} Stop that server, then check again.</p>;
    case "failed":
      return <p className="mt-1 text-sm leading-snug text-danger">{state.detail}</p>;
    case "disabled":
      return <p className={muted}>Tailscale Serve is turned off for this server (REPCOACH_TAILSCALE_SERVE=0).</p>;
  }
}

function CopyableUrl({ url }: { readonly url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() =>
        void navigator.clipboard?.writeText(url).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
      className="font-semibold break-all underline underline-offset-4"
      title="Copy"
    >
      {url}
      {copied && <span className="ml-1 text-xs font-normal text-text-muted no-underline">copied</span>}
    </button>
  );
}

/* ------------------------------------------------------ background service */

function BackgroundService({
  service,
  busy,
  onHandover,
  onChanged,
}: {
  readonly service: ServiceStatus;
  readonly busy: boolean;
  readonly onHandover: (why: string) => void;
  readonly onChanged: (message: string) => void;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = (call: () => Promise<{ ok: boolean; message: string; restarting: boolean }>, why: string) => {
    setWorking(true);
    setError(null);
    void call()
      .then((result) => {
        if (!result.ok) setError(result.message);
        else if (result.restarting) onHandover(why);
        else onChanged(result.message);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setWorking(false));
  };

  const disabled = working || busy;
  const button =
    "rounded-control border border-border px-3 py-1.5 text-sm active:bg-surface-sunken disabled:opacity-40";

  return (
    <div className="mt-5">
      <h4 className="font-numeric text-[0.6875rem] tracking-widest text-text-muted uppercase">Background service</h4>
      {service.kind === null ? (
        <p className="mt-1 text-sm leading-snug text-text-muted">{service.detail}</p>
      ) : service.managed && service.installed ? (
        <>
          <p className="mt-1 text-sm leading-snug">
            <span className="mr-1.5 inline-block size-2 rounded-full bg-confirm align-middle" aria-hidden />
            Running as a background service. {service.detail}
          </p>
          {service.logPath !== null && (
            <p className="mt-1 text-xs leading-snug break-all text-text-muted">Log: {service.logPath}</p>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" disabled={disabled} onClick={() => act(serverAdmin.restart, "restart")} className={button}>
              Restart server
            </button>
            <button type="button" disabled={disabled} onClick={() => act(serverAdmin.uninstallService, "remove")} className={button}>
              Remove service
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="mt-1 text-sm leading-snug">
            <span className="mr-1.5 inline-block size-2 rounded-full bg-deviation align-middle" aria-hidden />
            {service.managed
              ? "Service removed. This server keeps running until it stops, and won't be restarted."
              : service.installed
                ? "Installed, but this server was started by hand — the service takes over at your next logon."
                : "Not installed. This server stops when the window or terminal that started it closes."}
          </p>
          <p className="mt-1 text-sm leading-snug text-text-muted">{service.detail}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={disabled}
              onClick={() => act(serverAdmin.installService, "handing over to the background service")}
              className="rounded-control bg-confirm px-3 py-1.5 text-sm font-semibold text-canvas disabled:opacity-40"
            >
              {working ? "Installing…" : service.installed ? "Hand over to the service now" : "Install as background service"}
            </button>
            {service.installed && (
              <button type="button" disabled={disabled} onClick={() => act(serverAdmin.uninstallService, "remove")} className={button}>
                Remove service
              </button>
            )}
          </div>
        </>
      )}
      {service.legacy.length > 0 && (
        <div className="mt-2 text-xs leading-snug text-deviation">
          <p>Older launchers found — they would start a second copy:</p>
          <ul className="mt-1 list-disc pl-4">
            {service.legacy.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          {service.kind === "startup-folder" && <p className="mt-1">Installing the service removes the Startup-folder one.</p>}
        </div>
      )}
      {error !== null && <p className="mt-2 text-xs text-danger">{error}</p>}
    </div>
  );
}

/* ---------------------------------------------------------- paired devices */

function PairedDevices({
  server,
  pairingOpen,
  onPairingOpen,
  onChanged,
}: {
  readonly server: ServerStatus;
  readonly pairingOpen: boolean;
  readonly onPairingOpen: (open: boolean) => void;
  readonly onChanged: () => void;
}) {
  return (
    <div className="mt-5">
      <h4 className="font-numeric text-[0.6875rem] tracking-widest text-text-muted uppercase">Paired devices</h4>
      <ul className="mt-2 flex flex-col gap-2">
        {server.devices.map((device) => (
          <DeviceRow key={device.id} device={device} current={device.id === server.currentDeviceId} onRevoked={onChanged} />
        ))}
      </ul>
      {pairingOpen ? (
        <PairDevicePanel knownDeviceIds={server.devices.map((device) => device.id)} devices={server.devices} onClose={() => onPairingOpen(false)} />
      ) : (
        <button
          type="button"
          onClick={() => onPairingOpen(true)}
          className="mt-3 rounded-control bg-confirm px-3 py-1.5 text-sm font-semibold text-canvas"
        >
          Pair a device
        </button>
      )}
    </div>
  );
}

function DeviceRow({
  device,
  current,
  onRevoked,
}: {
  readonly device: PairedDevice;
  readonly current: boolean;
  readonly onRevoked: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const revoke = () => {
    void serverAdmin.revokeDevice(device.id).then(() => {
      if (current) window.location.reload();
      else onRevoked();
    });
  };
  return (
    <li className="flex items-start justify-between gap-3 text-sm leading-snug">
      <div className="min-w-0">
        <span className="font-semibold">{device.label}</span>
        {current && <span className="ml-1.5 text-xs text-text-muted">(this device)</span>}
        <p className="text-xs text-text-muted">
          Paired {new Date(device.createdAt).toLocaleDateString()} · last seen {new Date(device.lastSeenAt).toLocaleString()}
        </p>
      </div>
      {confirming ? (
        <span className="flex shrink-0 gap-1.5">
          <button type="button" onClick={revoke} className="text-xs font-semibold text-danger underline underline-offset-4">
            {current ? "Unpair this device" : "Confirm"}
          </button>
          <button type="button" onClick={() => setConfirming(false)} className="text-xs text-text-muted underline underline-offset-4">
            Cancel
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="shrink-0 text-xs text-text-muted underline underline-offset-4"
        >
          Revoke
        </button>
      )}
    </li>
  );
}

function PairDevicePanel({
  knownDeviceIds,
  devices,
  onClose,
}: {
  readonly knownDeviceIds: ReadonlyArray<string>;
  readonly devices: ReadonlyArray<PairedDevice>;
  readonly onClose: () => void;
}) {
  const [link, setLink] = useState<PairingLink | { readonly error: string } | null>(null);
  const before = useRef(new Set(knownDeviceIds));
  const newlyPaired = devices.find((device) => !before.current.has(device.id));

  const mint = useCallback(() => {
    setLink(null);
    void serverAdmin.createPairingLink().then(setLink, (cause: unknown) =>
      setLink({ error: cause instanceof Error ? cause.message : String(cause) }),
    );
  }, []);
  useEffect(mint, [mint]);

  return (
    <div className="mt-3 rounded-control border border-border p-3">
      {newlyPaired !== undefined ? (
        <p className="text-sm leading-snug text-confirm" role="status">
          Paired {newlyPaired.label}.
        </p>
      ) : link === null ? (
        <p className="text-sm text-text-muted">Making a pairing link…</p>
      ) : "error" in link ? (
        <p className="text-sm text-danger">Could not make a pairing link — {link.error}</p>
      ) : (
        <>
          <p className="text-sm leading-snug">Scan this with the device you want to pair, or open the link on it.</p>
          {!link.url.startsWith("https://") && (
            <p className="mt-1 text-xs leading-snug text-deviation">
              Phone access isn't set up yet, so this link only works on this computer.
            </p>
          )}
          <div
            className="mt-3 w-48 max-w-full rounded-control bg-white p-2"
            // Generated by the server's QR encoder from the link below; no user content.
            dangerouslySetInnerHTML={{ __html: link.qrSvg }}
          />
          <p className="mt-2 font-numeric text-[0.6875rem] leading-snug break-all text-text-muted">{link.url}</p>
          <p className="mt-1 text-xs leading-snug text-text-muted">
            Works once, until {new Date(link.expiresAt).toLocaleTimeString()}. Treat it like a password.
          </p>
        </>
      )}
      <div className="mt-3 flex gap-3">
        <button type="button" onClick={onClose} className="text-sm underline underline-offset-4">
          {newlyPaired !== undefined ? "Done" : "Close"}
        </button>
        {newlyPaired === undefined && (
          <button type="button" onClick={mint} className="text-sm text-text-muted underline underline-offset-4">
            New link
          </button>
        )}
      </div>
    </div>
  );
}
