import { afterEach, expect, test } from 'bun:test';
import { readAccountNames, saveAccountNames } from '../src/services/accountNames';
const original=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
afterEach(()=>{if(original)Object.defineProperty(globalThis,'localStorage',original);else Reflect.deleteProperty(globalThis,'localStorage');});
test('names persist and malformed entries are rejected',()=>{
 let saved='{}';Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:()=>saved,setItem:(_:string,value:string)=>{saved=value;}}});
 expect(saveAccountNames({'claude-account-test.json':'Personal Max'})).toBe(true);
 expect(readAccountNames()).toEqual({'claude-account-test.json':'Personal Max'});
 saved='{"__proto__":"bad","claude-account-test.json":123}';expect(readAccountNames()).toEqual({});
 saved='invalid';expect(readAccountNames()).toEqual({});
});
test('storage failure is reported instead of claiming persistence',()=>{
 Object.defineProperty(globalThis,'localStorage',{configurable:true,get:()=>{throw Error('Denied')}});
 expect(readAccountNames()).toEqual({});expect(saveAccountNames({})).toBe(false);
});
