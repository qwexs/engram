import {expect,test} from 'bun:test';
import {boundedMaintenanceEmbed} from './maintenance-embed-batch.ts';
import {buildQmdInvocation} from './invocation.ts';
import {authorizeQmdInvocation} from './policy.ts';
import type {QmdContext,QmdCallerContext} from './types.ts';
const context:QmdContext={workspace:'/synthetic/workspace',workspaceSource:'explicit',topology:'shared',selector:{kind:'named',name:'synthetic-index'},
 physicalIndex:{path:'/synthetic/index.sqlite',key:'synthetic-index',exists:false},command:{executable:'qmd',prefixArgs:['--gonka-free-tier']},
 policy:{ownedCollections:['synthetic-memory'],readableCollections:['synthetic-memory']},warnings:[]};
const caller:QmdCallerContext={kind:'provisioning',capabilities:['maintenance'],allowedCollections:[]};
test('bounded embedding preserves index, timeout, rate flag, scope and inherited environment',async()=>{
 const invocation=buildQmdInvocation(context,{operation:'embed',collections:['synthetic-memory'],timeoutMs:600000});
 const options={caller,decision:authorizeQmdInvocation(context,invocation,caller),env:{SYNTHETIC_SETTING:'unchanged'}};
 let observed:any;const execute=boundedMaintenanceEmbed(1,async(c,i,o)=>{observed={context:c,invocation:i,options:o};return {ok:true} as any;});
 await execute(context,invocation,options);
 expect(observed.invocation.argv).toEqual(['--gonka-free-tier','--max-docs-per-batch','1','--index','synthetic-index','embed','--format','json','-c','synthetic-memory']);
 expect(observed.invocation.collections).toEqual(invocation.collections);expect(observed.invocation.indexKey).toBe(invocation.indexKey);
 expect(observed.invocation.timeoutMs).toBe(600000);expect(observed.options.env).toBe(options.env);expect(observed.options.decision.allowed).toBe(true);
 expect(context.command.prefixArgs).toEqual(['--gonka-free-tier']);expect(observed.invocation.argv).not.toContain('-f');
});
test('non-embedding maintenance is delegated unchanged',async()=>{
 const invocation=buildQmdInvocation(context,{operation:'update'}),options={caller,decision:authorizeQmdInvocation(context,invocation,caller)};
 const execute=boundedMaintenanceEmbed(1,async(c,i,o)=>{expect(c).toBe(context);expect(i).toBe(invocation);expect(o).toBe(options);return {ok:true} as any;});
 await execute(context,invocation,options);
});
test('invalid batch sizes and altered canonical commands fail before execution',async()=>{
 for(const n of [0,-1,65,1.5,NaN])expect(()=>boundedMaintenanceEmbed(n)).toThrow();
 const invocation=buildQmdInvocation(context,{operation:'embed',collections:['synthetic-memory']});let calls=0;
 const execute=boundedMaintenanceEmbed(1,async()=>{calls++;return {ok:true} as any;});
 await expect(execute(context,{...invocation,argv:[...invocation.argv,'-f']},{caller,decision:authorizeQmdInvocation(context,invocation,caller)})).rejects.toThrow('canonical invocation');
 expect(calls).toBe(0);
});
