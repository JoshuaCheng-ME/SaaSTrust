// services/emailService.js
// SaaSTrust.net — Resend Email Service
// All templates: Linear/Stripe style, Inter/Arial, #1a1a1a text, minimal borders

const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY || 're_placeholder');

const FROM_EMAIL = process.env.FROM_EMAIL || 'SaaSTrust <no-reply@saastrust.net>';

// ─── HTML Wrapper (Linear/Stripe style) ───
const emailWrapper = (content) => `
<div style="max-width:560px;margin:40px auto;padding:32px;border:1px solid #e5e5e5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1a1a;line-height:1.6;">
  <div style="margin-bottom:32px;">
    <span style="font-weight:700;font-size:18px;letter-spacing:-0.5px;">SaaSTrust<span style="color:#666;">.net</span></span>
  </div>
  ${content}
  <hr style="margin-top:40px;border:0;border-top:1px solid #efefef;" />
  <p style="font-size:12px;color:#888;margin-top:16px;">
    This is an automated operational message from SaaSTrust.net. Please do not reply directly to this email.
  </p>
</div>
`;

// ─── Template 1: Employer Welcome ───
const employerWelcome = (name) => emailWrapper(`
  <h2 style="font-size:20px;font-weight:600;margin-bottom:16px;letter-spacing:-0.3px;">Welcome to SaaSTrust, ${name}</h2>
  <p style="font-size:14px;margin-bottom:24px;">Your premium B2B SaaS review matchmaking infrastructure is now ready. Let's start building unshakeable social proof on major organic platforms.</p>
  <div style="margin-bottom:24px;">
    <p style="font-size:14px;font-weight:600;margin-bottom:8px;">Next steps to scale:</p>
    <ol style="font-size:14px;padding-left:20px;margin:0;color:#444;">
      <li style="margin-bottom:6px;">Launch a new Campaign in your dashboard.</li>
      <li style="margin-bottom:6px;">Activate via Gumroad payment packages ($149 / $299).</li>
      <li style="margin-bottom:6px;">Get high-quality reviews from 100% verified, LinkedIn-vetted professionals.</li>
    </ol>
  </div>
  <a href="https://saastrust.net" style="display:inline-block;background:#1a1a1a;color:#fff;padding:10px 20px;text-decoration:none;font-size:14px;font-weight:500;border-radius:4px;">Go to Dashboard</a>
`);

// ─── Template 2: Payment Submitted (Employer) ───
const paymentPending = (campaignTitle, gumroadEmail) => emailWrapper(`
  <h2 style="font-size:20px;font-weight:600;margin-bottom:16px;letter-spacing:-0.3px;">Order Verification in Progress</h2>
  <p style="font-size:14px;">We have received your payment confirmation request for the campaign: <strong style="color:#000;">${campaignTitle}</strong>.</p>
  <div style="background:#f9f9f9;padding:16px;border-radius:4px;margin:20px 0;font-size:14px;">
    <strong>Submitted Payment Email:</strong> ${gumroadEmail}
  </div>
  <p style="font-size:14px;">Our automated ledger is cross-checking this with Gumroad. Your campaign status will automatically turn to <span style="background:#e1f5fe;color:#0288d1;padding:2px 6px;border-radius:3px;font-size:12px;font-weight:600;">Active</span> and be dispatched to reviewers within 12–24 hours.</p>
`);

// ─── Template 3: Reviewer Task Locked ───
const reviewerTaskLocked = (campaignTitle) => emailWrapper(`
  <h2 style="font-size:20px;font-weight:600;margin-bottom:16px;letter-spacing:-0.3px;">Task Secured Successfully</h2>
  <p style="font-size:14px;">You have successfully claimed the campaign: <strong>${campaignTitle}</strong>. A slot has been locked exclusively for your LinkedIn profile.</p>
  <div style="background:#fff3e0;border-left:4px solid #ffb74d;padding:12px;margin:20px 0;font-size:13px;color:#e65100;">
    ⚠️ <strong>Crucial Rule:</strong> Your submission must match your professional background. Upload the G2 screenshot showing "Review Under Moderation" within the required timeframe to avoid penalization.
  </div>
  <a href="https://saastrust.net" style="display:inline-block;background:#1a1a1a;color:#fff;padding:10px 20px;text-decoration:none;font-size:14px;font-weight:500;border-radius:4px;">View Task & Guidelines</a>
`);

// ─── Template 4: Employer — Review Submitted Notification ───
const employerReviewSubmitted = (campaignTitle) => emailWrapper(`
  <h2 style="font-size:20px;font-weight:600;margin-bottom:16px;letter-spacing:-0.3px;">New Review Submitted!</h2>
  <p style="font-size:14px;">A LinkedIn-verified professional has just completed a review submission for your campaign: <strong>${campaignTitle}</strong>.</p>
  <p style="font-size:14px;">The evidence screenshot is currently queued in our administration pipeline. Once G2 completes its platform moderation (typically 2–3 business days), the organic social proof will fully manifest on your public listing page.</p>
  <a href="https://saastrust.net" style="display:inline-block;background:#1a1a1a;color:#fff;padding:10px 20px;text-decoration:none;font-size:14px;font-weight:500;border-radius:4px;">Check Campaign Progress</a>
`);

// ─── Template 5: Reviewer — Gift Card Delivered ───
const reviewerPayout = (cardCode) => emailWrapper(`
  <h2 style="font-size:20px;font-weight:600;margin-bottom:16px;letter-spacing:-0.3px;color:#2e7d32;">Your Reward Has Arrived! 🎉</h2>
  <p style="font-size:14px;">Thank you for your premium, high-quality contribution. Our admin team has verified your G2 screenshot against your LinkedIn alignment credentials.</p>
  <div style="background:#f4fbf7;border:1px dashed #a5d6a7;padding:20px;text-align:center;border-radius:6px;margin:24px 0;">
    <span style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#666;display:block;margin-bottom:6px;">Amazon.com Gift Card Code</span>
    <span style="font-family:monospace;font-size:22px;font-weight:700;color:#1b5e20;letter-spacing:1px;">${cardCode}</span>
  </div>
  <div style="font-size:13px;color:#666;">
    <strong>How to redeem your $15 USD balance:</strong><br/>
    1. Go to <a href="https://amazon.com" style="color:#1a1a1a;font-weight:600;">amazon.com</a><br/>
    2. Sign in to your account and enter the claim code above.<br/>
    3. The $15 balance will instantly apply to your next eligible purchase.
  </div>
`);

// ─── Generic sender (non-blocking) ───
const sendEmail = async (to, subject, html) => {
  try {
    const result = await resend.emails.send({ from: FROM_EMAIL, to, subject, html });
    console.log('[Email] Sent:', subject, '→', to, result?.id || '');
    return { ok: true, id: result?.id };
  } catch (err) {
    console.error('[Email] Failed:', subject, '→', to, err.message || err);
    return { ok: false, error: err.message };
  }
};

// ─── Public API: 5 trigger functions ───
// All functions are fire-and-forget: they never throw, never block the caller.

/**
 * Trigger 1: Employer registration welcome
 */
const sendEmployerWelcome = (email, name) => {
  return sendEmail(email, 'Welcome to SaaSTrust.net! 🚀', employerWelcome(name));
};

/**
 * Trigger 2: Employer submitted payment email
 */
const sendPaymentPending = (email, campaignTitle, gumroadEmail) => {
  return sendEmail(email, `Order Received: Campaign Verification in Progress 💳`, paymentPending(campaignTitle, gumroadEmail));
};

/**
 * Trigger 3: Reviewer successfully claimed a task
 */
const sendReviewerTaskLocked = (email, campaignTitle) => {
  return sendEmail(email, `Task Confirmed: ${campaignTitle} is locked for you 🔒`, reviewerTaskLocked(campaignTitle));
};

/**
 * Trigger 4: Reviewer submitted proof → notify employer
 */
const sendEmployerReviewSubmitted = (email, campaignTitle) => {
  return sendEmail(email, `Good News: New Review Submitted for ${campaignTitle} 🎉`, employerReviewSubmitted(campaignTitle));
};

/**
 * Trigger 5: Admin approved payout → send gift card
 */
const sendReviewerPayout = (email, cardCode, productName) => {
  return sendEmail(email, `Your $15 Amazon Gift Card from SaaSTrust.net is here! 🎁`, reviewerPayout(cardCode));
};

module.exports = {
  sendEmployerWelcome,
  sendPaymentPending,
  sendReviewerTaskLocked,
  sendEmployerReviewSubmitted,
  sendReviewerPayout,
};
