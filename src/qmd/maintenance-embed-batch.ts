import {contextError} from '../cli/errors.ts';
import {buildQmdInvocation} from './invocation.ts';
import {authorizeQmdInvocation} from './policy.ts';
import {runQmdInvocation} from './runner.ts';
import type {QmdMaintenanceExecutor} from './maintenance.ts';

/** Coordinator-only sizing of QMD's documented document batches. No force,
 * model/rate/collection changes, generic passthrough or credential overrides. */
export function boundedMaintenanceEmbed(maxDocsPerBatch=1,execute:QmdMaintenanceExecutor=runQmdInvocation):QmdMaintenanceExecutor {
 if(!Number.isSafeInteger(maxDocsPerBatch)||maxDocsPerBatch<1||maxDocsPerBatch>64)throw contextError('Embedding document batch must be an integer from 1 to 64.');
 return async(context,invocation,options)=>{
  if(invocation.operation!=='embed')return execute(context,invocation,options);
  const expected=buildQmdInvocation(context,{operation:'embed',collections:invocation.collections,timeoutMs:invocation.timeoutMs});
  if(JSON.stringify(expected)!==JSON.stringify(invocation))throw contextError('Embedding batch adapter requires a canonical invocation.');
  const original=authorizeQmdInvocation(context,invocation,options.caller);
  if(!original.allowed)throw contextError('Embedding batch adapter has no maintenance authority.');
  const adjusted={...context,command:{...context.command,prefixArgs:[...context.command.prefixArgs,'--max-docs-per-batch',String(maxDocsPerBatch)]}};
  const bounded=buildQmdInvocation(adjusted,{operation:'embed',collections:invocation.collections,timeoutMs:invocation.timeoutMs});
  const decision=authorizeQmdInvocation(adjusted,bounded,options.caller);
  return execute(adjusted,bounded,{...options,decision});
 };
}
