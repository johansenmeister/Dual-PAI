/**
 * Contract test: `technitiumApi.ts cluster` reduces the cluster state (#501)
 *
 * Two answers: the shape measured on 15.6.2 (`ipAddresses` as a list,
 * `upSince`, no `configLastSynced`) and the shape APIDOCS shows (`ipAddress`,
 * `configLastSynced`, a never-seen node). Both must give the nodes and say
 * which of them are not healthy.
 */

import { describe, expect, test } from "bun:test";
import { summarizeCluster } from "./cluster";

const MEASURED = {
	version: "15.6.2",
	dnsServerDomain: "node0.dns.example",
	clusterInitialized: true,
	clusterDomain: "dns.example",
	heartbeatRefreshIntervalSeconds: 30,
	heartbeatRetryIntervalSeconds: 10,
	configRefreshIntervalSeconds: 900,
	configRetryIntervalSeconds: 60,
	clusterNodes: [
		{
			id: 1,
			name: "node0.dns.example",
			url: "https://node0.dns.example:53443/",
			ipAddresses: ["192.0.2.19"],
			type: "Primary",
			state: "Self",
			version: "15.6.2",
			upSince: "2026-10-25T17:07:20Z",
		},
		{
			id: 2,
			name: "node1.dns.example",
			url: "https://node1.dns.example:53443/",
			ipAddresses: ["192.0.2.20"],
			type: "Secondary",
			state: "Connected",
			version: "15.6.2",
			upSince: "2026-10-26T22:04:39Z",
			lastSeen: "2026-10-28T22:46:59Z",
		},
	],
};

const DOCUMENTED = {
	clusterInitialized: true,
	dnsServerDomain: "server1.example.com",
	clusterDomain: "example.com",
	configLastSynced: "2025-09-26T12:30:16Z",
	clusterNodes: [
		{ name: "server1.example.com", ipAddress: "192.0.2.5", type: "Secondary", state: "Self", lastSeen: "0001-01-01T00:00:00" },
		{ name: "server2.example.com", ipAddress: "192.0.2.101", type: "Secondary", state: "Unreachable", lastSeen: "0001-01-01T00:00:00" },
		{ name: "server3.example.com", ipAddress: "192.0.2.102", type: "Primary", state: "Connected", lastSeen: "2025-09-26T12:30:16Z" },
	],
};

describe("summarizeCluster", () => {
	test("the measured 15.6.2 answer gives every node, and none unhealthy", () => {
		const s = summarizeCluster(MEASURED);
		expect(s.clusterInitialized).toBe(true);
		expect(s.clusterDomain).toBe("dns.example");
		expect(s.self).toBe("node0.dns.example");
		expect(s.heartbeatRefreshIntervalSeconds).toBe(30);
		expect(s.configLastSynced).toBeUndefined();
		expect(s.unhealthy).toEqual([]);
		expect(s.nodes).toEqual([
			{
				name: "node0.dns.example",
				type: "Primary",
				state: "Self",
				version: "15.6.2",
				url: "https://node0.dns.example:53443/",
				ipAddresses: ["192.0.2.19"],
				upSince: "2026-10-25T17:07:20Z",
				lastSeen: undefined,
			},
			{
				name: "node1.dns.example",
				type: "Secondary",
				state: "Connected",
				version: "15.6.2",
				url: "https://node1.dns.example:53443/",
				ipAddresses: ["192.0.2.20"],
				upSince: "2026-10-26T22:04:39Z",
				lastSeen: "2026-10-28T22:46:59Z",
			},
		]);
	});

	test("the documented answer: a single ipAddress, a never-seen node, and the sync time", () => {
		const s = summarizeCluster(DOCUMENTED);
		expect(s.configLastSynced).toBe("2025-09-26T12:30:16Z");
		expect(s.unhealthy).toEqual(["server2.example.com"]);
		expect(s.nodes.map((n) => n.ipAddresses)).toEqual([["192.0.2.5"], ["192.0.2.101"], ["192.0.2.102"]]);
		expect(s.nodes.map((n) => n.lastSeen)).toEqual([undefined, undefined, "2025-09-26T12:30:16Z"]);
	});

	test("a server without a cluster says so, with no nodes", () => {
		expect(summarizeCluster({ clusterInitialized: false, clusterNodes: [] })).toEqual({
			clusterInitialized: false,
			nodes: [],
			unhealthy: [],
		});
		expect(summarizeCluster(undefined).clusterInitialized).toBe(false);
	});
});
