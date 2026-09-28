export function createVersionManagementVisitTracker() {
  const seenVisits = new WeakSet<object>();

  return (visit: object) => {
    if (seenVisits.has(visit)) return false;
    seenVisits.add(visit);
    return true;
  };
}
