import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import {PWARegister} from "@/components/PWARegister";
const sans=Geist({variable:"--font-sans",subsets:["latin"]}); const mono=Geist_Mono({variable:"--font-mono",subsets:["latin"]});
export const metadata:Metadata={title:"Personal Ledger",description:"Private personal accounting and Tally ERP 9 migration workspace.",manifest:"/manifest.webmanifest",themeColor:"#10223f",appleWebApp:{capable:true,title:"Personal Ledger",statusBarStyle:"default"},openGraph:{title:"Personal Ledger",description:"Your complete financial history, carried forward.",images:[{url:"/og.png",width:1746,height:907}]},twitter:{card:"summary_large_image",title:"Personal Ledger",description:"Your complete financial history, carried forward.",images:["/og.png"]}};
export default function Layout({children}:{children:React.ReactNode}){return <html lang="en"><body className={`${sans.variable} ${mono.variable}`}>{children}<PWARegister/></body></html>}