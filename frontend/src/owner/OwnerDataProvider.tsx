import type {Session,SupabaseClient,User} from '@supabase/supabase-js'
import {createContext,useCallback,useContext,useEffect,useMemo,useRef,useState,type ReactNode} from 'react'
import {clearOwnerLocalStorage,clearOwnerPasswordRecoveryLocation,nextOwnerWatchlist,normalizeOwnerTicker,ownerPasswordRecoveryRedirect,watchlistAfterSessionChange,type JsonRecord} from './ownerState'
import {isBrowserSafeSupabaseKey,OWNER_DATA_SCHEMA} from './supabasePublicConfig'

type OwnerSupabaseClient=SupabaseClient<any,any,typeof OWNER_DATA_SCHEMA,any,any>
const DEFAULT_WATCHLIST='Default'
const TABLES={
  watchlists:'eod_watchlists',savedScreens:'eod_saved_screens',drawings:'eod_drawings',
  alerts:'eod_alerts',alertEvents:'eod_alert_events',deliveryState:'eod_delivery_state',
} as const

export type OwnerSavedScreen={id:string;name:string;definition:JsonRecord;created_at?:string;updated_at?:string}
export type OwnerDrawing={id:string;ticker:string;interval:string;payload:JsonRecord;created_at?:string;updated_at?:string}
export type OwnerAlert={id:string;name:string;ticker:string|null;payload:JsonRecord;enabled:boolean;created_at?:string;updated_at?:string}
export type OwnerSavedScreenInput={id?:string;name:string;definition:JsonRecord}
export type OwnerDrawingInput={id?:string;ticker:string;interval:string;payload:JsonRecord}
export type OwnerAlertInput={id?:string;name:string;ticker:string|null;payload:JsonRecord;enabled:boolean}

type OwnerContextValue={
  configured:boolean
  loading:boolean
  user:User|null
  error:string
  passwordRecovery:boolean
  watchlist:string[]
  signIn:(email:string,password:string)=>Promise<boolean>
  signOut:()=>Promise<void>
  requestPasswordReset:(email:string)=>Promise<void>
  updatePassword:(password:string)=>Promise<boolean>
  toggleWatch:(ticker:string)=>Promise<void>
  listSavedScreens:()=>Promise<OwnerSavedScreen[]>
  saveSavedScreen:(screen:OwnerSavedScreenInput)=>Promise<void>
  deleteSavedScreen:(id:string)=>Promise<void>
  listDrawings:(ticker:string)=>Promise<OwnerDrawing[]>
  saveDrawing:(drawing:OwnerDrawingInput)=>Promise<void>
  deleteDrawing:(id:string)=>Promise<void>
  listAlerts:()=>Promise<OwnerAlert[]>
  saveAlert:(alert:OwnerAlertInput)=>Promise<void>
  deleteAlert:(id:string)=>Promise<void>
}

const OwnerContext=createContext<OwnerContextValue|null>(null)

function ownerConfig(){
  const url=import.meta.env.VITE_SUPABASE_URL?.trim()
  const key=import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()
  if(!url||!key||!isBrowserSafeSupabaseKey(key))return null
  return{url,key}
}
function clearOwnerCache(){
  if(typeof localStorage!=='undefined')clearOwnerLocalStorage(localStorage)
}

export function OwnerDataProvider({children}:{children:ReactNode}){
  const[config]=useState(ownerConfig)
  const[client,setClient]=useState<OwnerSupabaseClient|null>(null)
  const[session,setSession]=useState<Session|null>(null)
  const[loading,setLoading]=useState(Boolean(config))
  const[error,setError]=useState('')
  const[passwordRecovery,setPasswordRecovery]=useState(false)
  const[watchlist,setWatchlist]=useState<string[]>([])
  const activeUserId=useRef<string|null>(null)
  const user=session?.user??null

  const applySession=useCallback((next:Session|null)=>{
    const nextUserId=next?.user.id??null
    setWatchlist(current=>watchlistAfterSessionChange(current,activeUserId.current,nextUserId))
    activeUserId.current=nextUserId
    if(!nextUserId)clearOwnerCache()
    setSession(next)
  },[])

  useEffect(()=>{
    if(!config){clearOwnerCache();setLoading(false);return}
    if(typeof localStorage!=='undefined')clearOwnerLocalStorage(localStorage)
    let live=true
    import('@supabase/supabase-js').then(({createClient})=>{
      if(live)setClient(createClient(config.url,config.key,{db:{schema:OWNER_DATA_SCHEMA},auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}}))
    }).catch(next=>{if(live){setError(next instanceof Error?next.message:String(next));setLoading(false)}})
    return()=>{live=false}
  },[config])

  useEffect(()=>{
    if(!client){setLoading(false);return}
    let live=true
    client.auth.getSession().then(({data,error:sessionError})=>{
      if(!live)return
      if(sessionError)setError(sessionError.message)
      if(data.session&&new URLSearchParams(location.search).has('owner-recovery'))setPasswordRecovery(true)
      applySession(data.session);setLoading(false)
    })
    const{data:{subscription}}=client.auth.onAuthStateChange((event,next)=>{
      if(!live)return
      if(event==='PASSWORD_RECOVERY')setPasswordRecovery(true)
      if(event==='SIGNED_OUT')setPasswordRecovery(false)
      applySession(next)
    })
    return()=>{live=false;subscription.unsubscribe()}
  },[client,applySession])

  useEffect(()=>{
    if(!client||!user){setWatchlist([]);return}
    let live=true
    const ownerId=user.id
    client.from(TABLES.watchlists).select('ticker').eq('user_id',ownerId).eq('name',DEFAULT_WATCHLIST).order('ticker').then(({data,error:queryError})=>{
      if(!live||activeUserId.current!==ownerId)return
      if(queryError){setError(queryError.message);return}
      setWatchlist((data??[]).map(row=>String(row.ticker).toUpperCase()))
    })
    return()=>{live=false}
  },[client,user?.id])

  const signIn=useCallback(async(email:string,password:string)=>{
    if(!client){setError('Owner sync is not configured for this deployment.');return false}
    setLoading(true);setError('')
    const{data,error:signInError}=await client.auth.signInWithPassword({email,password})
    setLoading(false)
    if(signInError){setError(signInError.message);return false}
    applySession(data.session);return true
  },[client,applySession])

  const signOut=useCallback(async()=>{
    applySession(null);setPasswordRecovery(false);setError('')
    if(!client)return
    const{error:signOutError}=await client.auth.signOut()
    if(signOutError)setError(signOutError.message)
  },[client,applySession])

  const requestPasswordReset=useCallback(async(email:string)=>{
    setError('')
    if(!client)return
    setLoading(true)
    // Deliberately keep the response indistinguishable for unknown users,
    // rate limits, and delivery failures so the UI cannot enumerate accounts.
    try{
      await client.auth.resetPasswordForEmail(email.trim(),{
        redirectTo:ownerPasswordRecoveryRedirect(window.location),
      })
    }catch{}
    finally{setLoading(false)}
  },[client])

  const updatePassword=useCallback(async(password:string)=>{
    if(!client||!session){setError('This recovery link is no longer valid. Request a new one.');return false}
    setLoading(true);setError('')
    const{error:updateError}=await client.auth.updateUser({password})
    setLoading(false)
    if(updateError){setError(updateError.message);return false}
    setPasswordRecovery(false)
    try{history.replaceState(history.state,'',clearOwnerPasswordRecoveryLocation(location.href))}catch{}
    return true
  },[client,session])

  const toggleWatch=useCallback(async(ticker:string)=>{
    if(!client||!user){
      const ownerError=new Error('Owner sign-in is required to change the watchlist.')
      setError(ownerError.message);throw ownerError
    }
    const normalized=normalizeOwnerTicker(ticker)
    const removing=watchlist.includes(normalized)
    const next=nextOwnerWatchlist(watchlist,normalized,user.id)
    setWatchlist(next);setError('')
    const result=await client.rpc('eod_set_watchlist_ticker',{
      p_name:DEFAULT_WATCHLIST,p_ticker:normalized,p_present:!removing,
    })
    if(result.error){
      if(activeUserId.current===user.id)setWatchlist(watchlist)
      setError(result.error.message);throw result.error
    }
  },[client,user,watchlist])

  const requireOwner=useCallback(()=>{
    if(!client||!user)throw new Error('Owner sign-in is required')
    return{client,user}
  },[client,user])

  const listSavedScreens=useCallback(async()=>{
    const{client:ownerClient,user:owner}=requireOwner()
    const{data,error:queryError}=await ownerClient.from(TABLES.savedScreens).select('id,name,definition,created_at,updated_at').eq('user_id',owner.id).order('updated_at',{ascending:false})
    if(queryError)throw queryError
    return(data??[]) as OwnerSavedScreen[]
  },[requireOwner])
  const saveSavedScreen=useCallback(async(screen:OwnerSavedScreenInput)=>{
    const{client:ownerClient,user:owner}=requireOwner()
    const name=screen.name.trim()
    if(!name||name.length>80)throw new Error('Screen name must use 1-80 characters.')
    const result=screen.id
      ?await ownerClient.from(TABLES.savedScreens).update({name,definition:screen.definition}).eq('id',screen.id).eq('user_id',owner.id)
      :await ownerClient.from(TABLES.savedScreens).insert({user_id:owner.id,name,definition:screen.definition})
    if(result.error)throw result.error
  },[requireOwner])
  const deleteSavedScreen=useCallback(async(id:string)=>{
    const{client:ownerClient,user:owner}=requireOwner()
    const{error:deleteError}=await ownerClient.from(TABLES.savedScreens).delete().eq('id',id).eq('user_id',owner.id)
    if(deleteError)throw deleteError
  },[requireOwner])

  const listDrawings=useCallback(async(ticker:string)=>{
    const{client:ownerClient,user:owner}=requireOwner()
    const normalized=normalizeOwnerTicker(ticker)
    const{data,error:queryError}=await ownerClient.from(TABLES.drawings).select('id,ticker,interval,payload,created_at,updated_at').eq('user_id',owner.id).eq('ticker',normalized).order('updated_at',{ascending:false})
    if(queryError)throw queryError
    return(data??[]) as OwnerDrawing[]
  },[requireOwner])
  const saveDrawing=useCallback(async(drawing:OwnerDrawingInput)=>{
    const{client:ownerClient,user:owner}=requireOwner()
    const ticker=normalizeOwnerTicker(drawing.ticker),interval=drawing.interval.trim()
    if(!interval||interval.length>20)throw new Error('Drawing interval must use 1-20 characters.')
    const result=drawing.id
      ?await ownerClient.from(TABLES.drawings).update({ticker,interval,payload:drawing.payload}).eq('id',drawing.id).eq('user_id',owner.id)
      :await ownerClient.from(TABLES.drawings).insert({user_id:owner.id,ticker,interval,payload:drawing.payload})
    if(result.error)throw result.error
  },[requireOwner])
  const deleteDrawing=useCallback(async(id:string)=>{
    const{client:ownerClient,user:owner}=requireOwner();const{error:deleteError}=await ownerClient.from(TABLES.drawings).delete().eq('id',id).eq('user_id',owner.id)
    if(deleteError)throw deleteError
  },[requireOwner])

  const listAlerts=useCallback(async()=>{
    const{client:ownerClient,user:owner}=requireOwner()
    const{data,error:queryError}=await ownerClient.from(TABLES.alerts).select('id,name,ticker,payload,enabled,created_at,updated_at').eq('user_id',owner.id).order('updated_at',{ascending:false})
    if(queryError)throw queryError
    return(data??[]) as OwnerAlert[]
  },[requireOwner])
  const saveAlert=useCallback(async(alert:OwnerAlertInput)=>{
    const{client:ownerClient,user:owner}=requireOwner()
    const name=alert.name.trim(),ticker=normalizeOwnerTicker(alert.ticker??'',true)
    if(!name||name.length>120)throw new Error('Alert name must use 1-120 characters.')
    const values={name,ticker,payload:alert.payload,enabled:alert.enabled}
    const result=alert.id
      ?await ownerClient.from(TABLES.alerts).update(values).eq('id',alert.id).eq('user_id',owner.id)
      :await ownerClient.from(TABLES.alerts).insert({user_id:owner.id,...values})
    if(result.error)throw result.error
  },[requireOwner])
  const deleteAlert=useCallback(async(id:string)=>{
    const{client:ownerClient,user:owner}=requireOwner();const{error:deleteError}=await ownerClient.from(TABLES.alerts).delete().eq('id',id).eq('user_id',owner.id)
    if(deleteError)throw deleteError
  },[requireOwner])

  const value=useMemo<OwnerContextValue>(()=>({
    configured:Boolean(config),loading,user,error,passwordRecovery,watchlist,signIn,signOut,requestPasswordReset,updatePassword,toggleWatch,
    listSavedScreens,saveSavedScreen,deleteSavedScreen,listDrawings,saveDrawing,deleteDrawing,listAlerts,saveAlert,deleteAlert,
  }),[config,loading,user,error,passwordRecovery,watchlist,signIn,signOut,requestPasswordReset,updatePassword,toggleWatch,listSavedScreens,saveSavedScreen,deleteSavedScreen,listDrawings,saveDrawing,deleteDrawing,listAlerts,saveAlert,deleteAlert])
  return<OwnerContext.Provider value={value}>{children}</OwnerContext.Provider>
}

export function useOwnerData(){
  const value=useContext(OwnerContext)
  if(!value)throw new Error('useOwnerData must be used within OwnerDataProvider')
  return value
}
