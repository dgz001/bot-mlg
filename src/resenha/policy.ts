export type BanterPolicy = {
  authorized: boolean; optedOut: boolean; enabled: boolean; spontaneous: boolean;
  lastGroupAt: number; lastUserAt: number; spontaneousLastHour: number;
};
export function allowBanter(policy: BanterPolicy, trigger: 'mention' | 'reply' | 'command' | 'event' | 'spontaneous', at: number): boolean {
  if (!Number.isFinite(at) || !policy.authorized || !policy.enabled || policy.optedOut) return false;
  if (at - policy.lastGroupAt < 60000 || at - policy.lastUserAt < 30000) return false;
  if (trigger === 'spontaneous' && (!policy.spontaneous || policy.spontaneousLastHour >= 2)) return false;
  return true;
}
export type Memory = {
  id: string; groupId: string; kind: 'alias' | 'rivalry' | 'joke' | 'championship';
  subjects: string[]; text: string; source: string;
  status: 'candidate' | 'approved' | 'rejected'; reviewedBy?: string;
};
// Actor and admin list must come from the trusted authorization/database layer.
// This function approves structured editorial memory, not arbitrary AI facts.
export function approveMemory(candidate: Memory, actor: string, admins: string[]): Memory {
  if (!admins.includes(actor)) throw new Error('Somente ADM autorizado.');
  if (candidate.status !== 'candidate') throw new Error('Memória já revisada.');
  if (!candidate.source.trim() || !candidate.subjects.length || !candidate.groupId || !candidate.text.trim()) throw new Error('Memória exige fonte, grupo, texto e sujeitos.');
  if (candidate.kind === 'championship') throw new Error('Títulos exigem resultado confirmado do Minicamp.');
  return { ...structuredClone(candidate), status: 'approved', reviewedBy: actor };
}
