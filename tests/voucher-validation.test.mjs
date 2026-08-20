import test from "node:test";
import assert from "node:assert/strict";
import {validateVoucher} from "../lib/voucher-validation.js";
const accounts=[
 {id:1,name:"Expense",parent:"Indirect Expenses",active:true},
 {id:2,name:"Income",parent:"Indirect Incomes",active:true},
 {id:3,name:"Bank",parent:"Bank Accounts",active:true},
 {id:4,name:"Cash",parent:"Cash-in-hand",active:true},
 {id:5,name:"Other Bank",parent:"Bank Accounts",active:true},
 {id:6,name:"Payable",parent:"Current Liabilities",active:true},
 {id:7,name:"Inactive",parent:"Indirect Expenses",active:false}
];
const voucher=(type,debit,credit)=>({type,entries:[{accountId:debit,amount:-100},{accountId:credit,amount:100}]});
test("Payment requires Bank or Cash credit",()=>{assert.equal(validateVoucher(voucher("Payment",1,3),accounts).valid,true);assert.match(validateVoucher(voucher("Payment",1,6),accounts).errors.join(" "),/credit side/)});
test("Receipt requires Bank or Cash debit",()=>{assert.equal(validateVoucher(voucher("Receipt",3,2),accounts).valid,true);assert.match(validateVoucher(voucher("Receipt",1,2),accounts).errors.join(" "),/debit side/)});
test("Contra permits only Cash and Bank ledgers",()=>{assert.equal(validateVoucher(voucher("Contra",4,3),accounts).valid,true);assert.match(validateVoucher(voucher("Contra",1,3),accounts).errors.join(" "),/only Bank/)});
test("Journal excludes Cash and Bank ledgers",()=>{assert.equal(validateVoucher(voucher("Journal",1,6),accounts).valid,true);assert.match(validateVoucher(voucher("Journal",1,3),accounts).errors.join(" "),/cannot contain Bank/)});
test("structural rules reject imbalance, duplicate and inactive ledger",()=>{assert.match(validateVoucher({type:"Journal",entries:[{accountId:1,amount:-100},{accountId:6,amount:90}]},accounts).errors.join(" "),/equal/);assert.match(validateVoucher(voucher("Journal",1,1),accounts).errors.join(" "),/same ledger/);assert.match(validateVoucher(voucher("Journal",7,6),accounts).errors.join(" "),/Inactive/)});
test("multi-line balanced Journal is accepted",()=>{const v={type:"Journal",entries:[{accountId:1,amount:-100},{accountId:2,amount:40},{accountId:6,amount:60}]};assert.equal(validateVoucher(v,accounts).valid,true)});