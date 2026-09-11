import React from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import { AgentsPage } from '../../src/pages/AgentsPage';
import { I18nProvider } from '../../src/i18n';
import '../../src/styles.css';
const params = new URLSearchParams(location.search);
if(params.has('reset-selections'))localStorage.removeItem('cpa-gui.agent-model-selections.v1');
localStorage.setItem('easy-cli-proxy-api.locale',params.get('locale') || 'zh-CN');
document.documentElement.dataset.theme = params.get('theme') || 'light';
localStorage.setItem('cpa-gui.agent-selected-client.v1', params.get('client') || 'codex');
const ids = ['claude-code','claude-desktop','codex','opencode','openclaw','hermes','deepseek-harness','zcode','kimi-code','grok-build','pi'];
let count=0; let backupCount=0; const backups:any[]=[]; let currentModel=params.has('fresh')?null:'gpt-one';
let currentOauth=false; const currentMappings:Record<string,any>={};
let harnessProvider:Record<string,unknown>={};
const harnessConfigurations:Record<string,Record<string,unknown>>={};
let harnessRevision=1;
const harnessModels=[
 {id:'gpt-one',defaults:{input:['text','image'],contextWindow:128000}},
 {id:'gpt-two',defaults:{input:['text']}},
 {id:'unknown-model',defaults:{}},
];
const harnessSnapshot=()=>({revision:String(harnessRevision),provider:harnessProvider,baseUrl:'http://127.0.0.1:8317/v1',defaultModel:currentModel,configured:!!currentModel,models:harnessModels.map(m=>({...m,configuration:harnessConfigurations[m.id]??{}}))});
let harnessStatus={running:params.has('running'),pid:params.has('running')?100:null as number|null,mode:params.has('running')?params.get('harness-mode')||'web':null as string|null};
let appliedCount=0;
const calls:any[]=[];(window as any).fixtureCalls=calls;
let embedded=params.has('embedded');
(window as any).fixtureSessionIds=Array.from({length:61},(_,index)=>`session-${index+1}`);
mockIPC(async (cmd,args:any) => {
 calls.push({cmd,args});
 if(cmd==='plugin:event|listen') return 1;
 if(cmd==='plugin:event|unlisten'||cmd==='set_app_locale') return null;
 if(cmd==='get_agent_config_statuses'||cmd==='refresh_agent_config_statuses') return ids.map(id=>({id,name:id,supportedPlatform:true,installed:!params.has('not-installed'),pluginInstalled:!params.has('no-plugin'),launchTargets:params.has('not-installed')?[]:['claude-desktop','zcode'].includes(id)?[{id:'app',label:id,detail:'test desktop'}]:['codex','opencode'].includes(id)&&!params.has('cli-only')?[...(params.has('app-only')?[]:[{id:'cli',label:'CLI',detail:'test CLI'}]),{id:'app',label:'APP',detail:'test desktop'}]:[{id:'cli',label:'CLI',detail:'test CLI'}],version:'1.0',cliVersion:'1.0',appVersion:null,pluginVersion:'1.0',configValid:params.get('state')!=='invalid',connectionState:params.get('state') || (currentModel?'configured':'not-configured'),configured:!!currentModel,configurationSynchronized:!!currentModel,currentModel,oauthConfiguration:id==='codex'&&currentOauth,modificationEnabled:!!currentModel,modificationState:currentModel?'applied':'unconfigured',backupAvailable:false,appliedModel:currentModel,claudeCodeModelMappings:id==='claude-code'?currentMappings[id]??null:null,claudeDesktopModelMappings:id==='claude-desktop'?currentMappings[id]??null:null,warnings:[],error:null}));
 if(cmd==='get_agent_models') {
   if(args.client==='deepseek-harness')return harnessModels.map(m=>({name:m.id,inputModalities:m.defaults.input}));
   return [{name:'gpt-one'},{name:'gpt-two'}];
 }
 if(cmd==='list_codex_sessions') {
   const {offset,limit}=args.request;
   const sessionIds:string[]=[...(window as any).fixtureSessionIds];
   if((window as any).fixtureDeferSessionLoad) {
     (window as any).fixtureDeferSessionLoad=false;
     await new Promise<void>(resolve=>{(window as any).fixtureFinishSessionLoad=resolve;});
   }
   if((window as any).fixtureFailSessionLoad)throw new Error('模拟会话读取失败');
   return {codexHome:'C:/test/.codex',databasePaths:['C:/test/.codex/state.sqlite'],totalCount:sessionIds.length,offset,limit,hasMore:offset+limit<sessionIds.length,warnings:[],sessions:sessionIds.slice(offset,offset+limit).map(id=>({id,title:id,cwd:'C:/test/project',modelProvider:'test',archived:false,updatedAtMs:null,databasePath:'C:/test/.codex/state.sqlite'}))};
 }
 if(cmd==='get_deepseek_harness_process_status') return harnessStatus;
 if(cmd==='restart_agent_app'||cmd==='restart_deepseek_harness_process') {
   if(params.has('defer-restart'))await new Promise<void>(resolve=>{(window as any).fixtureFinishRestart=resolve;});
   if(params.has('fail-restart')) { if(cmd==='restart_deepseek_harness_process')harnessStatus={running:false,pid:null,mode:null}; throw new Error('模拟重启失败'); }
   if(cmd==='restart_deepseek_harness_process')return harnessStatus={running:true,pid:101,mode:'web'};
   return null;
 }
 if(cmd==='stop_deepseek_harness_process')return harnessStatus={running:false,pid:null,mode:null};
 if(cmd==='launch_agent')return null;
 if(cmd==='clear_codex_config') { currentModel=null; return []; }
 if(cmd==='uninstall_pi_provider')return null;
 if(['update_agent_config','repair_pi_provider','install_pi_provider','update_pi_provider'].includes(cmd)) {
   count++;if(params.has('fail-apply')&&count===1)throw new Error('模拟配置写入失败');
   currentModel=args.model;currentOauth=!!args.oauthConfiguration;
   currentMappings[args.client]=args.claudeCodeModelMappings??args.claudeDesktopModelMappings;
   return {outcome:count>1?'unchanged':'updated',model:currentModel,enabled:true,changedFiles:[],conflictFiles:[]};
 }
 if(cmd==='create_agent_config_backup') {
   const id=String(++backupCount);
   const files=[{path:'C:/test/.codex/config.toml',exists:true,size:120},{path:'C:/test/.codex/models.json',exists:true,size:60},{path:'C:/test/.codex/auth.json',exists:false,size:null}];
   const backup={id,createdAt:'2026-09-10T12:00:00Z',fileCount:3,location:'C:/CPA/backups/agents/'+args.client+'/'+id+'.json',files,restorable:params.get('state')!=='invalid',error:params.get('state')==='invalid'?'备份含有无法解析的配置':null,savedModel:currentModel};
   backups.unshift(backup);return backup;
 }
 if(cmd==='list_agent_config_backups') return {versions:backups};
 if(cmd==='preview_agent_config_backup') return {revision:'rev1',files:backups.find(b=>b.id===args.id).files,differences:[{file:'C:/test/.codex/config.toml',field:'file',before:'present',after:'replace'}]};
 if(cmd==='restore_agent_config_backup') {if(params.has('conflict'))throw new Error('预览后配置或备份发生变化，请重新预览');currentModel=backups.find(b=>b.id===args.id).savedModel;return {outcome:'updated'};}
 if(cmd==='delete_agent_config_backup') {backups.splice(backups.findIndex(b=>b.id===args.id),1);return null;}
 if(cmd==='preview_agent_config_template') return {revision:'template1',files:['C:/test/.codex/config.toml','C:/test/.codex/auth.json','C:/test/.codex/models.json']};
 if(cmd==='apply_agent_config_template') {currentModel=args.model;return {outcome:'updated'};}
 if(cmd==='check_pi_provider_update') return {installedVersion:'1.0',latestVersion:params.has('update')?'1.1':'1.0',updateAvailable:params.has('update')};
 if(cmd==='get_deepseek_harness_model_catalog_editor')return harnessSnapshot();
 if(cmd==='save_deepseek_harness_model_catalog_editor') {
   if((window as any).fixtureFailHarnessSave)throw new Error('模拟模型配置保存失败');
   if((window as any).fixtureStaleHarnessSave)throw new Error('DSH_MODEL_CATALOG_CHANGED');
   if((window as any).fixtureDeferHarnessSave)await new Promise<void>(resolve=>{(window as any).fixtureFinishHarnessSave=resolve;});
   harnessProvider=args.request.provider;
   for(const m of args.request.models)harnessConfigurations[m.id]=m.configuration;
   harnessRevision++;return harnessSnapshot();
 }
 if(cmd==='get_codex_model_catalog_editor') return {models:[],hiddenModels:[],customizations:{}};
 if(cmd==='check_codex_oauth_login')return null;
 throw new Error('Unhandled fixture command: '+cmd);
});
let root=createRoot(document.getElementById('root')!);
const render=()=>root.render(<I18nProvider><AgentsPage embedded={embedded} onConfigurationApplied={()=>{document.documentElement.dataset.fixtureApplied=String(++appliedCount);}}/></I18nProvider>);
(window as any).fixtureRemount=(nextEmbedded=embedded)=>{embedded=nextEmbedded;root.unmount();root=createRoot(document.getElementById('root')!);render();};
render();
