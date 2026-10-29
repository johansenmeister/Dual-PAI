/**
 * The cluster state from `/api/admin/cluster/state`, reduced to what answers
 * "how is the cluster doing" (#501).
 *
 * Field names as measured on 15.6.2 (2026-10-28), where they differ from
 * APIDOCS: `ipAddresses` is a list (APIDOCS: `ipAddress`), `upSince` is not
 * documented, and `configLastSynced` is documented but was missing from both
 * nodes' answers. It is passed on when present. A `lastSeen` of
 * `0001-01-01T00:00:00` means never, and is dropped.
 */

export interface ClusterNode {
	name: string;
	type: string;
	state: string;
	version?: string;
	url?: string;
	ipAddresses?: string[];
	upSince?: string;
	lastSeen?: string;
}

export interface ClusterSummary {
	clusterInitialized: boolean;
	clusterDomain?: string;
	/** The node that answered. */
	self?: string;
	heartbeatRefreshIntervalSeconds?: number;
	configRefreshIntervalSeconds?: number;
	configLastSynced?: string;
	nodes: ClusterNode[];
	/** Names of the nodes that are neither `Self` nor `Connected`. */
	unhealthy: string[];
}

const NEVER = /^0001-01-01/;
const HEALTHY = new Set(["Self", "Connected"]);

function str(v: unknown): string | undefined {
	return typeof v === "string" && v !== "" ? v : undefined;
}

function num(v: unknown): number | undefined {
	return typeof v === "number" ? v : undefined;
}

function node(raw: Record<string, unknown>): ClusterNode {
	const ips = Array.isArray(raw.ipAddresses)
		? raw.ipAddresses.filter((ip): ip is string => typeof ip === "string")
		: str(raw.ipAddress)
			? [raw.ipAddress as string]
			: undefined;
	const lastSeen = str(raw.lastSeen);
	return {
		name: str(raw.name) ?? "?",
		type: str(raw.type) ?? "?",
		state: str(raw.state) ?? "?",
		version: str(raw.version),
		url: str(raw.url),
		ipAddresses: ips,
		upSince: str(raw.upSince),
		lastSeen: lastSeen && !NEVER.test(lastSeen) ? lastSeen : undefined,
	};
}

export function summarizeCluster(response: unknown): ClusterSummary {
	const r = (response ?? {}) as Record<string, unknown>;
	if (r.clusterInitialized !== true) return { clusterInitialized: false, nodes: [], unhealthy: [] };
	const nodes = (Array.isArray(r.clusterNodes) ? r.clusterNodes : [])
		.filter((n): n is Record<string, unknown> => typeof n === "object" && n !== null)
		.map(node);
	return {
		clusterInitialized: true,
		clusterDomain: str(r.clusterDomain),
		self: str(r.dnsServerDomain),
		heartbeatRefreshIntervalSeconds: num(r.heartbeatRefreshIntervalSeconds),
		configRefreshIntervalSeconds: num(r.configRefreshIntervalSeconds),
		configLastSynced: str(r.configLastSynced),
		nodes,
		unhealthy: nodes.filter((n) => !HEALTHY.has(n.state)).map((n) => n.name),
	};
}
