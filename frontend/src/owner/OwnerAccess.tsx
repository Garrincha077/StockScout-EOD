import {useState,type FormEvent} from 'react'
import {useOwnerData} from './OwnerDataProvider'
import {PASSWORD_RESET_REQUEST_NOTICE} from './ownerState'
import './owner.css'

export default function OwnerAccess(){
  const{configured,loading,user,error,passwordRecovery,signIn,signOut,requestPasswordReset,updatePassword}=useOwnerData()
  const[open,setOpen]=useState(false)
  const[resetMode,setResetMode]=useState(false)
  const[resetSent,setResetSent]=useState(false)
  const[email,setEmail]=useState('')
  const[password,setPassword]=useState('')
  const[confirmation,setConfirmation]=useState('')
  const[formError,setFormError]=useState('')
  const submit=async(event:FormEvent)=>{event.preventDefault();if(await signIn(email,password)){setPassword('');setOpen(false)}}
  const submitReset=async(event:FormEvent)=>{
    event.preventDefault();setFormError('')
    await requestPasswordReset(email)
    setResetSent(true)
  }
  const submitRecovery=async(event:FormEvent)=>{
    event.preventDefault();setFormError('')
    if(password!==confirmation){setFormError('Passwords do not match.');return}
    if(await updatePassword(password)){setPassword('');setConfirmation('')}
  }

  if(passwordRecovery)return<div className="owner-access owner-recovery-access">
    <form className="owner-popover owner-recovery-popover" onSubmit={submitRecovery}>
      <b>Set a new password</b><p>The recovery link is active. Choose a new password for the owner account.</p>
      <label>New password<input type="password" autoComplete="new-password" minLength={6} required value={password} onChange={event=>setPassword(event.target.value)}/></label>
      <label>Confirm password<input type="password" autoComplete="new-password" minLength={6} required value={confirmation} onChange={event=>setConfirmation(event.target.value)}/></label>
      {(formError||error)&&<small role="alert">{formError||error}</small>}
      <button type="submit" disabled={loading}>{loading?'Updating…':'Update password'}</button>
    </form>
  </div>
  if(user)return<div className="owner-access"><span title={user.email??'Owner'}>Owner · {user.email}</span><button onClick={signOut}>Sign out</button></div>
  return<div className="owner-access">
    <button className="owner-login" disabled={!configured||loading} onClick={()=>setOpen(value=>!value)}>{configured?'Owner sign in':'Public read-only'}</button>
    {open&&(resetMode
      ?<form className="owner-popover" onSubmit={submitReset}>
        <b>Reset owner password</b><p>Enter the owner email. For privacy, this page always returns the same result.</p>
        <label>Email<input type="email" autoComplete="email" required value={email} onChange={event=>setEmail(event.target.value)}/></label>
        {resetSent&&<small className="owner-reset-notice" role="status">{PASSWORD_RESET_REQUEST_NOTICE}</small>}
        <button type="submit" disabled={loading}>{loading?'Sending…':'Send recovery link'}</button>
        <button className="owner-link-button" type="button" onClick={()=>{setResetMode(false);setResetSent(false)}}>Back to sign in</button>
      </form>
      :<form className="owner-popover" onSubmit={submit}>
        <b>Owner access</b><p>Synced watchlists, drawings and alerts. Charts are always available.</p>
        <label>Email<input type="email" autoComplete="username" required value={email} onChange={event=>setEmail(event.target.value)}/></label>
        <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={event=>setPassword(event.target.value)}/></label>
        {error&&<small role="alert">{error}</small>}
        <button type="submit" disabled={loading}>{loading?'Signing in…':'Sign in'}</button>
        <button className="owner-link-button" type="button" onClick={()=>{setResetMode(true);setResetSent(false);setPassword('')}}>Forgot password?</button>
      </form>)}
  </div>
}
