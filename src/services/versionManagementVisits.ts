export function createVersionManagementVisitTracker() {
  const countedVisits = new WeakSet<object>();
  let visitsSinceLastCheck = 0;

  return (visit: object) => {
    if (countedVisits.has(visit)) return false;
    countedVisits.add(visit);
    visitsSinceLastCheck += 1;
    if (visitsSinceLastCheck < 5) return false;
    visitsSinceLastCheck = 0;
    return true;
  };
}
