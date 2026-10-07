import { describe, expect, it } from 'bun:test';
import { quotaAvailability, quotaPercent } from '../src/services/quotaAvailability';
import { quotaRowsFor, type QuotaState } from '../src/services/quotaService';
const now = 1800000000000;
const file = { provider:'claude', status:'active' };
const antigravity = { provider:'antigravity', status:'active' };
const grouped = (fractions: (number | null)[][]): QuotaState => ({ status:'success', fetchedAt:now, rows:quotaRowsFor('antigravity', {
  groups:fractions.map((values,i)=>({ displayName:`Group ${i+1}`, buckets:values.map((value,j)=>({
    remainingFraction:value, window:j===0?'5h':'weekly', resetTime:new Date(now+(i+1)*(j+1)*3600000).toISOString(),
  })) })),
}) });
describe('Antigravity reported model groups',()=>{
  it('recognizes available groups without inventing account-wide windows',()=>{
    const result=quotaAvailability(antigravity,grouped([[1,.5],[.8]]),now);
    expect(result.kind).toBe('available');
    expect(result.groups?.map(group=>group.kind)).toEqual(['available','available']);
  });
  it('limits only the group whose applicable window is empty',()=>{
    const result=quotaAvailability(antigravity,grouped([[1,0],[.8]]),now);
    expect(result.kind).toBe('limited');
    expect(result.groups?.map(group=>group.kind)).toEqual(['exhausted','available']);
  });
  it('uses the latest blocker per group and first independent group recovery',()=>{
    const result=quotaAvailability(antigravity,grouped([[0,0],[0,0]]),now);
    expect(result.kind).toBe('exhausted');
    expect(result.groups?.map(group=>group.recoveryAt)).toEqual([now+7200000,now+14400000]);
    expect(result.recoveryAt).toBe(now+7200000);
  });
  it('retains missing buckets and empty groups as unknown',()=>{
    const q=grouped([[1,null],[]]);
    expect(q.rows).toHaveLength(3);
    expect(q.rows.filter(row=>row.remainingPercent===null)).toHaveLength(2);
    expect(quotaAvailability(antigravity,q,now).groups?.map(group=>group.kind)).toEqual(['unknown','unknown']);
    expect(quotaAvailability(antigravity,grouped([[1],[null]]),now).kind).toBe('unknown');
  });
  it('does not guess recovery or treat a passed reset as renewed quota',()=>{
    const q=grouped([[0],[0]]);
    q.rows[0].resetAtMs=undefined;
    expect(quotaAvailability(antigravity,q,now).recoveryAt).toBeUndefined();
    q.rows.forEach(row=>row.resetAtMs=now-1);
    expect(quotaAvailability(antigravity,q,now).kind).toBe('resetDue');
  });
  it('honors stale snapshots and disabled accounts before group availability',()=>{
    expect(quotaAvailability(antigravity,grouped([[1]]),now,true).kind).toBe('unknown');
    expect(quotaAvailability(antigravity,{...grouped([[1]]),fetchedAt:now-400000},now).kind).toBe('unknown');
    expect(quotaAvailability({...antigravity,disabled:true},grouped([[1]]),now).kind).toBe('disabled');
  });
});
const snapshot = (weekly = 0, session = 93, model = 100): QuotaState => ({ status:'success', fetchedAt:now, rows:[
  { scope:'model', label:'Fable', remainingPercent:model, resetAtMs:now+86400000 },
  { scope:'account', label:'Session', remainingPercent:session, resetAtMs:now+3600000 },
  { scope:'account', label:'Weekly', remainingPercent:weekly, resetAtMs:now+5*86400000 },
] });
describe('included quota availability',()=>{
  it('blocks a full Fable allowance behind an exhausted overall week',()=>{
    const state=quotaAvailability(file,snapshot(),now);
    expect(state.kind).toBe('exhausted'); expect(state.recoveryAt).toBe(now+5*86400000);
    expect(state.blockers.map(row=>row.label)).toEqual(['Weekly']);
  });
  it('waits for every applicable blocker, not the earliest reset',()=>{
    expect(quotaAvailability(file,snapshot(0,0),now).recoveryAt).toBe(now+5*86400000);
    expect(quotaAvailability(file,snapshot(90,0),now).recoveryAt).toBe(now+3600000);
  });
  it('keeps scoped and paid exhaustion separate',()=>{
    expect(quotaAvailability(file,snapshot(90,90,0),now).kind).toBe('limited');
    const q=snapshot(90); q.rows.push({scope:'paid',label:'Extra',remainingPercent:0});
    expect(quotaAvailability(file,q,now).kind).toBe('available');
  });
  it('does not claim unknown, stale or failed snapshots are available',()=>{
    for(const q of [undefined,{...snapshot(90),status:'error' as const},{...snapshot(90),fetchedAt:now-400000},{...snapshot(90),rows:[]}]) expect(quotaAvailability(file,q,now).kind).toBe('unknown');
    expect(quotaAvailability(file,snapshot(90),now,true).kind).toBe('unknown');
    expect(quotaAvailability({...file,status:'pending'},snapshot(90),now).kind).toBe('unknown');
    expect(quotaAvailability({...file,status:''},snapshot(90),now).kind).toBe('unknown');
    const q=snapshot(90); q.rows[2].remainingPercent=null;
    expect(quotaAvailability(file,q,now).kind).toBe('unknown');
  });
  it('normalizes disabled states and retains recent evidence while refreshing',()=>{
    expect(quotaAvailability({...file,status:'disabled'},snapshot(90),now).kind).toBe('disabled');
    expect(quotaAvailability({...file,disabled:true},snapshot(90),now).kind).toBe('disabled');
    expect(quotaAvailability(file,{...snapshot(),status:'loading'},now).kind).toBe('exhausted');
  });
  it('requires fresh confirmation after reset and never guesses a missing reset',()=>{
    const q=snapshot(); q.rows[2].resetAtMs=now-1000;
    expect(quotaAvailability(file,q,now).kind).toBe('resetDue');
    delete q.rows[2].resetAtMs;
    expect(quotaAvailability(file,q,now).recoveryAt).toBeUndefined();
  });
  it('preserves positive fractions and stable provider scopes',()=>{
    expect(quotaPercent(.4)).toBe('<1'); expect(quotaPercent(0)).toBe('0');
    const rows=quotaRowsFor('claude',{five_hour:{utilization:1},seven_day:{utilization:100},iguana_necktie:{utilization:0},extra_usage:{is_enabled:true,utilization:100}});
    expect(rows.map(row=>row.scope)).toEqual(['account','account','model','paid']);
    expect(rows.map(row=>row.windowId)).toEqual(['five_hour','seven_day','iguana_necktie','extra_usage']);
    expect(quotaRowsFor('codex',{rate_limit:{primary_window:{used_percent:10}},code_review_rate_limit:{primary_window:{used_percent:100}}}).map(row=>row.scope)).toEqual(['account','model']);
  });
  it('does not infer a reset or all-model availability from invalid or partial evidence',()=>{
    const q=snapshot(); q.rows[2].resetAtMs=NaN;
    expect(quotaAvailability(file,q,now).kind).toBe('exhausted');
    expect(quotaAvailability(file,q,now).recoveryAt).toBeUndefined();
    const partial=snapshot(90); partial.rows[0].remainingPercent=null;
    expect(quotaAvailability(file,partial,now).kind).toBe('unknown');
    partial.rows[0].remainingPercent=.4;
    expect(quotaAvailability(file,partial,now).kind).toBe('available');
  });
});

describe('Grok availability explanations',()=>{
  const grok={provider:'xai',status:'active'};
  const q=(payload:unknown):QuotaState=>({status:'success',fetchedAt:now,rows:quotaRowsFor('xai',payload)});
  it('explains missing numbers without calling the account empty',()=>{
    const state=quotaAvailability(grok,q({config:{currentPeriod:{type:'weekly'}}}),now);
    expect(state).toMatchObject({kind:'unknown',reason:'notReported'});
  });
  it('separates paid credentials from proven chat access',()=>{
    expect(quotaAvailability(grok,q({mode:'paid-info'}),now)).toMatchObject({kind:'unknown',reason:'paidQuota'});
  });
  it('does not infer a global limit from unvalidated billing constraints',()=>{
    expect(quotaAvailability(grok,q({config:{monthlyLimit:1000,used:0}}),now)).toMatchObject({kind:'unknown',reason:'unmapped'});
  });
  it('stale and disabled states supersede provider explanations',()=>{
    expect(quotaAvailability(grok,q({mode:'paid-info'}),now,true).reason).toBeUndefined();
    expect(quotaAvailability({...grok,disabled:true},q({mode:'paid-info'}),now).kind).toBe('disabled');
  });
});
