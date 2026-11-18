import { FormEvent, useEffect, useState } from "react";
import { api } from "./api";

/**
 * PayPay / Kyash receiving accounts used by the Xaccount-Bot vending machines.
 * The separate 仕入れbot delegates payment checks to this same account through
 * the signed bridge, so one connection serves both bots.
 */
export default function PaymentSettings({
  onNotice, onError
}:{
  onNotice:(message:string)=>void;
  onError:(reason:unknown)=>void;
}){
  const [status,setStatus]=useState<{paypay:boolean;kyash:boolean}|null>(null);
  const [busy,setBusy]=useState(false);
  const [payPayForm,setPayPayForm]=useState({phone:"",password:"",challengeId:"",otp:""});
  const [kyashForm,setKyashForm]=useState({email:"",password:"",challengeId:"",otp:""});

  async function loadStatus(){
    try{ setStatus(await api<{paypay:boolean;kyash:boolean}>("/api/vending/payments/status")); }
    catch(reason){ onError(reason); }
  }

  useEffect(()=>{ void loadStatus(); },[]);

  async function run(action:()=>Promise<void>){
    setBusy(true);
    try{ await action(); }
    catch(reason){ onError(reason); }
    finally{ setBusy(false); }
  }

  const startPayPay=(event:FormEvent)=>{ event.preventDefault(); void run(async()=>{
    const result=await api<{challengeId:string}>("/api/vending/paypay/login/start",{
      method:"POST",body:JSON.stringify({phone:payPayForm.phone,password:payPayForm.password})
    });
    setPayPayForm(current=>({...current,challengeId:result.challengeId,otp:""}));
    onNotice("PayPayのSMS認証コードを入力してください");
  }); };

  const verifyPayPay=(event:FormEvent)=>{ event.preventDefault(); void run(async()=>{
    await api("/api/vending/paypay/login/verify",{
      method:"POST",body:JSON.stringify({challengeId:payPayForm.challengeId,otp:payPayForm.otp})
    });
    setPayPayForm({phone:"",password:"",challengeId:"",otp:""});
    await loadStatus();
    onNotice("PayPayアカウントを接続しました");
  }); };

  const disconnectPayPay=()=>{
    if(!window.confirm("保存されているPayPay接続情報を削除しますか？")) return;
    void run(async()=>{
      await api("/api/vending/paypay/logout",{method:"POST"});
      await loadStatus();
      onNotice("PayPayアカウントを切断しました");
    });
  };

  const startKyash=(event:FormEvent)=>{ event.preventDefault(); void run(async()=>{
    const result=await api<{challengeId:string}>("/api/vending/kyash/login/start",{
      method:"POST",body:JSON.stringify({email:kyashForm.email,password:kyashForm.password})
    });
    setKyashForm(current=>({...current,challengeId:result.challengeId,otp:""}));
    onNotice("KyashのSMS認証コードを入力してください");
  }); };

  const verifyKyash=(event:FormEvent)=>{ event.preventDefault(); void run(async()=>{
    await api("/api/vending/kyash/login/verify",{
      method:"POST",body:JSON.stringify({challengeId:kyashForm.challengeId,otp:kyashForm.otp})
    });
    setKyashForm({email:"",password:"",challengeId:"",otp:""});
    await loadStatus();
    onNotice("Kyashアカウントを接続しました");
  }); };

  return (
    <>
      <div className="xc-page-head">
        <div>
          <h1>PayPay設定</h1>
          <p>自販機の決済受取アカウントを接続します。仕入れbot（別Bot）の自販機もこの接続を使って決済を確認します。</p>
        </div>
      </div>

      <section className="xc-stat-grid">
        <article className={`xc-stat ${status?.paypay?"green":"red"}`}>
          <span>PayPay</span>
          <strong>● {status?(status.paypay?"連携中（有効）":"未接続"):"確認中"}</strong>
          <small>{status?.paypay?"決済受付稼働中":"下のフォームから接続"}</small>
        </article>
        <article className={`xc-stat ${status?.kyash?"green":"red"}`}>
          <span>Kyash</span>
          <strong>● {status?(status.kyash?"連携中（有効）":"未接続"):"確認中"}</strong>
          <small>{status?.kyash?"決済受付稼働中":"下のフォームから接続"}</small>
        </article>
      </section>

      <section className="xc-asset-grid">
        <article className="xc-card">
          <div className="xc-section-title"><div><h2>PayPay</h2><p>電話番号とパスワードでログインし、SMSのOTPで認証します。</p></div></div>
          {status?.paypay?(
            <div className="xc-form">
              <p className="muted">PayPayアカウントは接続済みです。</p>
              <div><button type="button" className="xc-btn red" disabled={busy} onClick={disconnectPayPay}>PayPay切断</button></div>
            </div>
          ):payPayForm.challengeId?(
            <form className="xc-form" onSubmit={verifyPayPay}>
              <label>SMS認証コード（OTP）
                <input value={payPayForm.otp} inputMode="numeric" maxLength={6} required onChange={event=>setPayPayForm({...payPayForm,otp:event.target.value})} placeholder="PayPay OTP" />
              </label>
              <div className="xc-form-footer">
                <button type="submit" className="xc-btn violet" disabled={busy}>認証して接続</button>
                <button type="button" className="xc-btn ghost" onClick={()=>setPayPayForm({phone:"",password:"",challengeId:"",otp:""})}>やり直す</button>
              </div>
            </form>
          ):(
            <form className="xc-form" onSubmit={startPayPay}>
              <label>電話番号<input value={payPayForm.phone} autoComplete="tel" required onChange={event=>setPayPayForm({...payPayForm,phone:event.target.value})} placeholder="PayPay 電話番号" /></label>
              <label>パスワード<input type="password" value={payPayForm.password} autoComplete="current-password" required onChange={event=>setPayPayForm({...payPayForm,password:event.target.value})} placeholder="PayPay パスワード" /></label>
              <div className="xc-form-footer"><button type="submit" className="xc-btn violet" disabled={busy}>PayPay接続</button></div>
            </form>
          )}
        </article>

        <article className="xc-card">
          <div className="xc-section-title"><div><h2>Kyash</h2><p>メールアドレスとパスワードでログインし、OTPで認証します。</p></div></div>
          {status?.kyash?(
            <p className="muted">Kyashアカウントは接続済みです。</p>
          ):kyashForm.challengeId?(
            <form className="xc-form" onSubmit={verifyKyash}>
              <label>認証コード（OTP）
                <input value={kyashForm.otp} inputMode="numeric" maxLength={8} required onChange={event=>setKyashForm({...kyashForm,otp:event.target.value})} placeholder="Kyash OTP" />
              </label>
              <div className="xc-form-footer">
                <button type="submit" className="xc-btn violet" disabled={busy}>認証して接続</button>
                <button type="button" className="xc-btn ghost" onClick={()=>setKyashForm({email:"",password:"",challengeId:"",otp:""})}>やり直す</button>
              </div>
            </form>
          ):(
            <form className="xc-form" onSubmit={startKyash}>
              <label>メールアドレス<input type="email" value={kyashForm.email} autoComplete="email" required onChange={event=>setKyashForm({...kyashForm,email:event.target.value})} placeholder="Kyash メール" /></label>
              <label>パスワード<input type="password" value={kyashForm.password} autoComplete="current-password" required onChange={event=>setKyashForm({...kyashForm,password:event.target.value})} placeholder="Kyash パスワード" /></label>
              <div className="xc-form-footer"><button type="submit" className="xc-btn violet" disabled={busy}>Kyash接続</button></div>
            </form>
          )}
        </article>
      </section>
    </>
  );
}
