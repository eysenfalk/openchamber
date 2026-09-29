/**
 * Persisted form of the config store's per-directory snapshots.
 *
 * Every project opened in this runtime keeps a snapshot of its provider and
 * agent lists, and nothing trims them. Those lists are almost always identical
 * between projects: a project config that declares its own provider or agent
 * is the exception. Kept inline, each snapshot repeats the whole model catalog,
 * so enough opened projects outgrow browser storage; the write then fails and
 * the snapshots every project paints from are lost. Persisted here, each
 * distinct list is stored once and the snapshots refer to it by index.
 *
 * The shared form lives under its own key, `directoryScopedShared`, so an older
 * build reading this storage finds no snapshots and loads them again instead of
 * reading an index where it expects a list.
 */

type SnapshotLists<Provider, AgentEntry> = { providers: Provider[]; agents: AgentEntry[] };

export type SharedSnapshot<Snapshot> = Omit<Snapshot, 'providers' | 'agents'> & { providers: number; agents: number };

export type SharedDirectorySnapshots<Snapshot, Provider, AgentEntry> = {
  providerLists: Provider[][];
  agentLists: AgentEntry[][];
  snapshots: Record<string, SharedSnapshot<Snapshot>>;
};

// A list is serialized once per object: the store keeps the same array while
// its contents are unchanged, so later writes only look the key up.
const contentKeys = new WeakMap<object, string>();

const contentKeyOf = (list: readonly unknown[]): string => {
  const cached = contentKeys.get(list);
  if (cached !== undefined) return cached;
  const key = JSON.stringify(list);
  contentKeys.set(list, key);
  return key;
};

const internList = <Entry>(list: Entry[], lists: Entry[][], indexByKey: Map<string, number>): number => {
  const key = contentKeyOf(list);
  const existing = indexByKey.get(key);
  if (existing !== undefined) return existing;
  lists.push(list);
  indexByKey.set(key, lists.length - 1);
  return lists.length - 1;
};

export function shareDirectorySnapshots<Provider, AgentEntry, Snapshot extends SnapshotLists<Provider, AgentEntry>>(
  snapshots: Record<string, Snapshot>,
): SharedDirectorySnapshots<Snapshot, Provider, AgentEntry> {
  const providerLists: Provider[][] = [];
  const agentLists: AgentEntry[][] = [];
  const providerIndex = new Map<string, number>();
  const agentIndex = new Map<string, number>();
  const shared: Record<string, SharedSnapshot<Snapshot>> = {};
  for (const [directoryKey, snapshot] of Object.entries(snapshots)) {
    shared[directoryKey] = {
      ...snapshot,
      providers: internList(snapshot.providers, providerLists, providerIndex),
      agents: internList(snapshot.agents, agentLists, agentIndex),
    };
  }
  return { providerLists, agentLists, snapshots: shared };
}

/**
 * Rebuilds the snapshots. Directories whose lists are equal share one array.
 * A snapshot that refers to a list that is not there is dropped, so that
 * directory loads its lists again rather than starting from a wrong one.
 */
export function restoreDirectorySnapshots<Provider, AgentEntry, Snapshot extends SnapshotLists<Provider, AgentEntry>>(
  shared: SharedDirectorySnapshots<Snapshot, Provider, AgentEntry>,
  build: (snapshot: SharedSnapshot<Snapshot>, lists: SnapshotLists<Provider, AgentEntry>) => Snapshot,
) {
  // Storage can hold anything; a malformed blob restores nothing.
  const wellFormed = Array.isArray(shared.providerLists) && Array.isArray(shared.agentLists) && Boolean(shared.snapshots);
  return Object.fromEntries((wellFormed ? Object.entries(shared.snapshots) : []).flatMap(([directoryKey, snapshot]) => {
    const providers = shared.providerLists[snapshot.providers];
    const agents = shared.agentLists[snapshot.agents];
    if (!Array.isArray(providers) || !Array.isArray(agents)) return [];
    return [[directoryKey, build(snapshot, { providers, agents })] as const];
  }));
}
