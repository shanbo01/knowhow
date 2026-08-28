"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { BrandMarkGlyph } from "@/app/components/brand-mark-glyph";
import { getAuthSession } from "../../../lib/auth-client";
import "./landing.css";

declare global {
  interface Window {
    __khMx?: number;
    __khMy?: number;
  }
}

const pricingPlans = (
  <div className="plans" role="region" aria-label="KnowHow plans">
    <article className="plan reveal">
      <div className="plan-top"><h2 className="plan-name">Free</h2><div className="plan-badge">Forever</div></div>
      <div className="plan-price">$0<small>forever</small></div>
      <div className="plan-sub">Create up to 15 guides, invite teammates, review, publish, share, and export to Markdown. Capture and screenshot privacy tools stay on Pro.</div>
      <Link className="plan-action" href="/register">Sign up for Free</Link>
      <div className="plan-rule"></div>
      <ul className="plan-list">
        <li>Up to 15 guides, review, and publish</li>
        <li>Invite teammates into a workspace</li>
        <li>Search and share inside the workspace</li>
        <li>Capture and Smart Blur stay on Pro</li>
      </ul>
      <div className="plan-foot">No card. Upgrade only when the team needs capture.</div>
    </article>
    <article className="plan pro reveal">
      <div className="plan-top"><h2 className="plan-name">Pro</h2><div className="plan-badge">14-day trial</div></div>
      <div className="plan-price">14-day<small>trial, no card</small></div>
      <div className="plan-sub">Capture, Smart Blur, redact, annotate, file exports, unbranding, and in-app support. After the trial, stay on Free or contact us to continue Pro.</div>
      <Link className="plan-action" href="/start-trial">Start free trial</Link>
      <div className="plan-rule"></div>
      <ul className="plan-list">
        <li>Everything in Free</li>
        <li>Browser capture extension</li>
        <li>Smart Blur, redact, and annotate</li>
        <li>PDF, PowerPoint, and HTML exports</li>
        <li>Unbranding and in-app support</li>
      </ul>
      <div className="plan-foot">No checkout is active yet. Authorization never depends on client-side billing state.</div>
    </article>
    <article className="plan enterprise reveal">
      <div className="plan-top"><h2 className="plan-name">Enterprise</h2><div className="plan-badge">Usage</div></div>
      <div className="plan-price">Let&apos;s talk</div>
      <div className="plan-sub">Same features as Pro, with more seats, storage, and bandwidth. We invoice offline and can talk on-prem later.</div>
      <div className="deploy-box">
        <div className="deploy-tabs">
          <button className="deploy-tab active" type="button" aria-pressed="true" data-deploy="saas">SaaS</button>
          <button className="deploy-tab" type="button" aria-pressed="false" data-deploy="onprem">On-prem</button>
        </div>
        <div className="deploy-copy"><b id="deployTitle"><span className="deploy-pulse"></span>Managed SaaS workspace</b><span id="deployText">We provision the workspace, apply enterprise limits, and help your team get the rollout right.</span></div>
      </div>
      <Link className="plan-action" href="/contact">Contact us</Link>
      <div className="plan-rule"></div>
      <ul className="plan-list">
        <li>The same core product as Pro</li>
        <li>Higher seat, storage, and bandwidth limits</li>
        <li>Offline invoicing</li>
        <li>Optional on-prem conversation later</li>
      </ul>
      <div className="plan-foot">Enterprise pays for scale and rollout help—not a different product.</div>
    </article>
  </div>
);

const captureDemoSteps = [
  {
    title: "Open People",
    sub: "Navigate to workspace members",
    hint: "click + Add member",
  },
  {
    title: "Choose Add member",
    sub: "Start the member creation flow",
    hint: "choose the Member role",
  },
  {
    title: "Set workspace role",
    sub: "Assign access before saving",
    hint: "finish the guide",
  },
] as const;

function particleField(canvas: HTMLCanvasElement, dark: boolean, density: number) {
  const maybeCtx = canvas.getContext("2d");
  if (!maybeCtx) return () => {};
  const ctx: CanvasRenderingContext2D = maybeCtx;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let w = 0;
  let h = 0;
  let cx = 0;
  let cy = 0;
  let pts: Array<{ r: number; a: number; ring: number; s: number; phase: number }> = [];
  let frame = 0;
  let running = true;
  function build() {
    pts = [];
    const rings = dark ? 8 : 9;
    const max = Math.min(w * 0.48, h * 0.64);
    for (let r = 0; r < rings; r++) {
      const radius = max * (0.25 + r * 0.105);
      const count = Math.floor((70 + r * 27) * density);
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + (r % 2) * 0.08;
        const jitter = (Math.sin(i * 17.31 + r * 4.7) * 0.5 + 0.5) * 9;
        pts.push({ r: radius + jitter, a, ring: r, s: Math.random() * 0.85 + 0.35, phase: Math.random() * 6.28 });
      }
    }
  }
  function resize() {
    const box = canvas.getBoundingClientRect();
    w = box.width;
    h = box.height;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx = w / 2;
    cy = h * 0.5;
    build();
  }
  function draw(t: number) {
    if (!running) return;
    const visible = canvas.getBoundingClientRect().bottom > 0 && canvas.getBoundingClientRect().top < window.innerHeight;
    if (visible) {
      ctx.clearRect(0, 0, w, h);
      const mx = (window.__khMx || 0.5) - 0.5;
      const my = (window.__khMy || 0.5) - 0.5;
      for (const p of pts) {
        const a = p.a + t * 0.000015 * (p.ring % 2 ? 1 : -1);
        const x = cx + Math.cos(a) * p.r + mx * (p.ring + 1) * 3;
        const y = cy + Math.sin(a) * p.r * 0.57 + my * (p.ring + 1) * 2;
        const alpha = (dark ? 0.23 : 0.18) + Math.sin(t * 0.001 + p.phase) * 0.06;
        ctx.beginPath();
        ctx.arc(x, y, p.s * (p.ring > 6 ? 0.7 : 1), 0, Math.PI * 2);
        ctx.fillStyle = dark ? `rgba(255,112,50,${alpha})` : `rgba(255,91,18,${alpha + 0.06})`;
        ctx.fill();
      }
    }
    frame = requestAnimationFrame(draw);
  }
  resize();
  window.addEventListener("resize", resize);
  frame = requestAnimationFrame(draw);
  return () => {
    running = false;
    cancelAnimationFrame(frame);
    window.removeEventListener("resize", resize);
  };
}

export function LandingExperience() {
  const [signedIn, setSignedIn] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [bootCount, setBootCount] = useState(0);
  const [bootDone, setBootDone] = useState(false);
  const [demoStep, setDemoStep] = useState(1);
  const [demoDone, setDemoDone] = useState(false);
  const navigationRef = useRef<HTMLElement>(null);

  useEffect(() => {
    void getAuthSession()
      .then((user) => setSignedIn(Boolean(user)))
      .catch(() => setSignedIn(false));
  }, []);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const reducedFrame = requestAnimationFrame(() => {
        setBootCount(100);
        setBootDone(true);
      });
      return () => cancelAnimationFrame(reducedFrame);
    }

    const startedAt = performance.now();
    let frame = 0;
    const tick = (time: number) => {
      const progress = Math.min(1, (time - startedAt) / 950);
      setBootCount(Math.round(progress * 100));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const finish = window.setTimeout(() => setBootDone(true), 1120);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(finish);
    };
  }, []);

  useEffect(() => {
    if (demoStep !== 4) return;
    const finish = window.setTimeout(() => setDemoDone(true), 620);
    return () => window.clearTimeout(finish);
  }, [demoStep]);

  useEffect(() => {
    const root = document.querySelector(".kh-landing");
    if (!root) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const cleanups: Array<() => void> = [];

    const hero = root.querySelector<HTMLElement>(".hero");
    const stage = root.querySelector<HTMLElement>(".product-stage");
    const rail = root.querySelector<HTMLElement>("#scrollRail");
    const cursor = root.querySelector<HTMLElement>("#khCursor");
    let cursorX = -100;
    let cursorY = -100;
    let targetX = -100;
    let targetY = -100;
    let cursorFrame = 0;

    const onMove = (event: PointerEvent) => {
      window.__khMx = event.clientX / window.innerWidth;
      window.__khMy = event.clientY / window.innerHeight;
      targetX = event.clientX;
      targetY = event.clientY;

      if (cursor && event.target instanceof Element) {
        const darkSurface = event.target.closest(
          ".story, .playground, .pricing-story, .final-panel, .narrative-bridge, .card.two, .capture-console",
        );
        cursor.classList.toggle("on-dark", Boolean(darkSurface));
      }

      if (hero) {
        const rect = hero.getBoundingClientRect();
        if (event.clientY >= rect.top && event.clientY <= rect.bottom) {
          hero.style.setProperty("--hx", `${(event.clientX / window.innerWidth) * 100}%`);
          hero.style.setProperty("--hy", `${((event.clientY - rect.top) / rect.height) * 100}%`);
        }
      }

      if (stage && window.innerWidth >= 700) {
        const x = (event.clientX / window.innerWidth - 0.5) * 4;
        const y = (event.clientY / window.innerHeight - 0.5) * 2;
        stage.style.transform = `translateX(-50%) perspective(1400px) rotateX(${5 - y}deg) rotateY(${x * 0.25}deg)`;
      }
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    cleanups.push(() => window.removeEventListener("pointermove", onMove));

    if (!reduced && window.matchMedia("(pointer: fine)").matches && cursor) {
      const cursorLoop = () => {
        cursorX += (targetX - cursorX) * 0.22;
        cursorY += (targetY - cursorY) * 0.22;
        cursor.style.transform = `translate(${cursorX}px, ${cursorY}px) translate(-50%, -50%)`;
        cursorFrame = requestAnimationFrame(cursorLoop);
      };
      cursorFrame = requestAnimationFrame(cursorLoop);
      cleanups.push(() => cancelAnimationFrame(cursorFrame));

      const cursorTargets = [...root.querySelectorAll<HTMLElement>("a, button, [data-cursor], .demo-hotspot")];
      const enterCursor = (event: Event) => {
        const target = event.currentTarget as HTMLElement;
        cursor.classList.add("active");
        if (target.dataset.label) {
          cursor.classList.add("label");
          const label = cursor.querySelector("span");
          if (label) label.textContent = target.dataset.label;
        }
      };
      const leaveCursor = () => cursor.classList.remove("active", "label");
      cursorTargets.forEach((target) => {
        target.addEventListener("pointerenter", enterCursor);
        target.addEventListener("pointerleave", leaveCursor);
      });
      cleanups.push(() => cursorTargets.forEach((target) => {
        target.removeEventListener("pointerenter", enterCursor);
        target.removeEventListener("pointerleave", leaveCursor);
      }));
    }

    const pageProgress = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      rail?.style.setProperty("transform", `scaleY(${max > 0 ? window.scrollY / max : 0})`);
    };
    window.addEventListener("scroll", pageProgress, { passive: true });
    pageProgress();
    cleanups.push(() => window.removeEventListener("scroll", pageProgress));

    if (!reduced && hero) {
      let heroClicks = 12;
      const heroCount = hero.querySelector(".capture-chip em");
      const captureClick = (event: Event) => {
        if (!(event instanceof PointerEvent) || !(event.target instanceof Element)) return;
        if (event.target.closest("a, button, .product-stage")) return;
        const rect = hero.getBoundingClientRect();
        if (event.clientY - rect.top > 690) return;
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        const ring = document.createElement("i");
        const card = document.createElement("i");
        ring.className = "hero-click-ring";
        card.className = "hero-click-card";
        ring.style.left = card.style.left = `${x}px`;
        ring.style.top = card.style.top = `${y}px`;
        hero.append(ring, card);
        heroClicks += 1;
        if (heroCount) heroCount.textContent = String(heroClicks);
        window.setTimeout(() => {
          ring.remove();
          card.remove();
        }, 900);
      };
      hero.addEventListener("pointerdown", captureClick);
      cleanups.push(() => hero.removeEventListener("pointerdown", captureClick));
    }

    if (!reduced) {
      const gravity = root.querySelector("#gravityCanvas");
      const finale = root.querySelector("#finalCanvas");
      if (gravity instanceof HTMLCanvasElement) cleanups.push(particleField(gravity, false, 1.05));
      if (finale instanceof HTMLCanvasElement) cleanups.push(particleField(finale, true, 0.75));
    }

    const story = root.querySelector(".story");
    const scenes = [...root.querySelectorAll(".story-card")];
    const bars = [...root.querySelectorAll(".story-progress i")];
    const storyScroll = () => {
      if (!(story instanceof HTMLElement)) return;
      const total = story.offsetHeight - window.innerHeight;
      const p = Math.max(0, Math.min(1, -story.getBoundingClientRect().top / Math.max(total, 1)));
      const centers = [0.08, 0.5, 0.92];
      scenes.forEach((el, i) => {
        if (!(el instanceof HTMLElement)) return;
        const dist = Math.abs(p - centers[i]);
        const o = Math.max(0, 1 - dist / 0.25);
        el.style.opacity = String(Math.min(1, o * 1.45));
        el.style.transform = `translate(-50%, calc(-50% + ${(p - centers[i]) * 110}px)) scale(${0.86 + o * 0.14})`;
      });
      bars.forEach((bar, i) => {
        if (!(bar instanceof HTMLElement)) return;
        const v = (p - i / 3) / (1 / 3);
        bar.style.setProperty("--p", String(Math.max(0, Math.min(1, v))));
      });
    };

    const prologue = root.querySelector(".prologue");
    const prologueLine = root.querySelector("#prologueLine");
    const prologueSub = root.querySelector("#prologueSub");
    const proPings = [...root.querySelectorAll(".prologue .ping")];
    const interruptCount = root.querySelector("#interruptCount");
    const recordAnswer = root.querySelector("#recordAnswer");
    const expertCard = root.querySelector("#expertCard");
    const expertOrbit = root.querySelector("#expertOrbit");
    const prologueCopy = [
      ["Every team has that person.", "The one who remembers the weird fix, the hidden setting, the exact order that makes everything work."],
      ["Their day becomes everyone else’s search bar.", "A question here. A screen share there. Small interruptions that quietly become a job of their own."],
      ["The same answer. Again. And again.", "The knowledge exists. It just disappears into chats, calls and memory the moment the problem is solved."],
      ["What if answering once was enough?", "Keep doing the work. Let KnowHow turn the answer into something the whole team can use next time."],
    ];
    let prologueState = -1;
    const updatePrologue = () => {
      if (!(prologue instanceof HTMLElement)) return;
      const total = prologue.offsetHeight - window.innerHeight;
      const p = Math.max(0, Math.min(1, -prologue.getBoundingClientRect().top / Math.max(total, 1)));
      const idx = p < 0.23 ? 0 : p < 0.5 ? 1 : p < 0.73 ? 2 : 3;
      if (idx !== prologueState) {
        prologueState = idx;
        if (prologueLine instanceof HTMLElement) prologueLine.textContent = prologueCopy[idx][0];
        if (prologueSub) prologueSub.textContent = prologueCopy[idx][1];
      }
      const visible = Math.min(proPings.length, Math.max(0, Math.floor((p - 0.12) / 0.055) + 1));
      proPings.forEach((el, i) => {
        el.classList.toggle("show", i < visible);
        el.classList.toggle("dismiss", p > 0.75 && i < visible);
      });
      if (interruptCount) interruptCount.textContent = String(Math.round(Math.max(0, (p - 0.08) / 0.62) * 27)).padStart(2, "0");
      const pressure = Math.max(0, Math.min(1, (p - 0.18) / 0.48));
      if (expertCard instanceof HTMLElement) {
        expertCard.style.transform = `translate(-50%, -50%) scale(${1 - pressure * 0.055})`;
      }
      if (expertOrbit instanceof HTMLElement) {
        expertOrbit.style.transform = `translate(-50%, -50%) scale(${0.82 + pressure * 0.16}) rotate(${p * 28}deg)`;
      }
      recordAnswer?.classList.toggle("show", p > 0.79);
    };

    const morph = root.querySelector(".morph");
    const rawShots = [...root.querySelectorAll(".raw-shot")];
    const morphGuide = root.querySelector("#morphGuide");
    const morphCaption = root.querySelector("#morphCaption");
    const morphWord = root.querySelector("#morphWord");
    const morphScroll = () => {
      if (!(morph instanceof HTMLElement)) return;
      const total = morph.offsetHeight - window.innerHeight;
      const p = Math.max(0, Math.min(1, -morph.getBoundingClientRect().top / Math.max(total, 1)));
      rawShots.forEach((el, i) => {
        if (!(el instanceof HTMLElement)) return;
        const sx = Number(el.dataset.sx || 0) * window.innerWidth / 100;
        const sy = Number(el.dataset.sy || 0) * window.innerHeight / 100;
        const rot = Number(el.dataset.r || 0);
        const q = Math.min(1, p / 0.72);
        const ease = 1 - Math.pow(1 - q, 3);
        const x = sx * (1 - ease) + 110 * ease;
        const y = sy * (1 - ease) + (i - 2.5) * 49 * ease;
        const fade = p > 0.72 ? Math.max(0, 1 - (p - 0.72) / 0.18) : 1;
        el.style.transform = `translate(-50%, -50%) translate3d(${x}px, ${y}px, ${(1 - ease) * 120}px) rotate(${rot * (1 - ease)}deg) scale(${1 - 0.27 * ease})`;
        el.style.opacity = String(fade);
      });
      const gp = Math.max(0, Math.min(1, (p - 0.3) / 0.55));
      if (morphGuide instanceof HTMLElement) {
        morphGuide.style.opacity = String(0.08 + gp * 0.92);
        morphGuide.style.transform = `translate(-50%, -50%) scale(${0.72 + gp * 0.28})`;
      }
      if (morphCaption instanceof HTMLElement) morphCaption.style.opacity = p > 0.72 ? String(Math.min(1, (p - 0.72) / 0.12)) : "0";
      morphWord?.classList.toggle("on", p > 0.57);
    };

    const onScroll = () => {
      if (reduced) return;
      storyScroll();
      updatePrologue();
      morphScroll();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    if (!reduced) onScroll();
    cleanups.push(() => window.removeEventListener("scroll", onScroll));

    if (!reduced) {
      const io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("in");
            io.unobserve(entry.target);
          }
        }
      }, { threshold: 0.13 });
      root.querySelectorAll(".reveal").forEach((el) => io.observe(el));
      cleanups.push(() => io.disconnect());

      const spotlightCards = [...root.querySelectorAll<HTMLElement>(".card")];
      const moveSpotlight = (event: Event) => {
        if (!(event instanceof PointerEvent)) return;
        const card = event.currentTarget as HTMLElement;
        const rect = card.getBoundingClientRect();
        card.style.setProperty("--gx", `${event.clientX - rect.left}px`);
        card.style.setProperty("--gy", `${event.clientY - rect.top}px`);
      };
      spotlightCards.forEach((card) => card.addEventListener("pointermove", moveSpotlight));
      cleanups.push(() => spotlightCards.forEach((card) => card.removeEventListener("pointermove", moveSpotlight)));

      if (window.matchMedia("(pointer: fine)").matches) {
        const magneticButtons = [...root.querySelectorAll<HTMLElement>(".magnetic")];
        const moveMagnet = (event: Event) => {
          if (!(event instanceof PointerEvent)) return;
          const button = event.currentTarget as HTMLElement;
          const rect = button.getBoundingClientRect();
          const x = event.clientX - (rect.left + rect.width / 2);
          const y = event.clientY - (rect.top + rect.height / 2);
          button.style.transform = `translate(${x * 0.11}px, ${y * 0.16}px) translateY(-2px)`;
        };
        const resetMagnet = (event: Event) => {
          (event.currentTarget as HTMLElement).style.transform = "";
        };
        magneticButtons.forEach((button) => {
          button.addEventListener("pointermove", moveMagnet);
          button.addEventListener("pointerleave", resetMagnet);
        });
        cleanups.push(() => magneticButtons.forEach((button) => {
          button.removeEventListener("pointermove", moveMagnet);
          button.removeEventListener("pointerleave", resetMagnet);
        }));
      }
    } else {
      root.querySelectorAll(".reveal").forEach((el) => el.classList.add("in"));
    }

    const deployCopy: Record<string, { title: string; text: string }> = {
      saas: { title: "Managed SaaS workspace", text: "We provision the workspace, apply enterprise limits, and help your team get the rollout right." },
      onprem: { title: "Provisioned in your environment", text: "KnowHow is deployed on-premises for your organization, with setup and rollout provisioned with your team." },
    };
    const onDeploy = (event: Event) => {
      const tab = event.currentTarget;
      if (!(tab instanceof HTMLElement)) return;
      root.querySelectorAll(".deploy-tab").forEach((item) => {
        const selected = item === tab;
        item.classList.toggle("active", selected);
        item.setAttribute("aria-pressed", selected ? "true" : "false");
      });
      const next = deployCopy[tab.dataset.deploy || "saas"];
      if (!next) return;
      const title = root.querySelector("#deployTitle");
      const text = root.querySelector("#deployText");
      if (title) title.innerHTML = '<span class="deploy-pulse"></span>' + next.title;
      if (text) text.textContent = next.text;
    };
    root.querySelectorAll(".deploy-tab").forEach((tab) => tab.addEventListener("click", onDeploy));
    cleanups.push(() => root.querySelectorAll(".deploy-tab").forEach((tab) => tab.removeEventListener("click", onDeploy)));

    if (window.location.hash.length > 1) {
      try {
        const target = root.querySelector(window.location.hash);
        if (target instanceof HTMLElement) target.scrollIntoView({ behavior: reduced ? "auto" : "smooth" });
      } catch {
        /* ignore malformed hashes */
      }
    }

    return () => cleanups.forEach((fn) => fn());
  }, []);

  const captureDemo = (step: number) => {
    if (step !== demoStep || step > captureDemoSteps.length) return;
    setDemoStep(step + 1);
  };

  const resetCaptureDemo = () => {
    setDemoStep(1);
    setDemoDone(false);
  };

  const scrollToSection = (event: ReactMouseEvent<HTMLAnchorElement>, selector: string) => {
    const section = document.querySelector(selector);
    if (!(section instanceof HTMLElement)) return;
    event.preventDefault();
    setMobileNavOpen(false);
    section.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "start",
    });
    window.history.replaceState(null, "", selector);
  };

  useEffect(() => {
    if (!mobileNavOpen) return;
    const closeMenu = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !navigationRef.current?.contains(event.target)
      ) {
        setMobileNavOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileNavOpen(false);
    };
    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [mobileNavOpen]);

  return (
    <div className="kh-landing">
<div className={`boot${bootDone ? " done" : ""}`} onPointerDown={() => setBootDone(true)} aria-hidden="true"><div className="boot-word">knowhow</div><div className="boot-count">{String(bootCount).padStart(2, "0")}</div><div className="boot-line"></div></div>
<div className="kh-cursor" id="khCursor" aria-hidden="true"><i></i><span>capture</span></div>
<div className="scroll-rail" aria-hidden="true"><i id="scrollRail"></i></div>
<div className="nav-wrap"><nav ref={navigationRef} className="nav shell" aria-label="Primary navigation">
  <a className="logo" href="#top"><span className="logo-mark"><BrandMarkGlyph /></span>knowhow</a>
  <div id="landing-primary-links" className={`nav-links${mobileNavOpen ? " open" : ""}`}><a href="#how" onClick={(event) => scrollToSection(event, "#how")}>How it works</a><a href="#product" onClick={(event) => scrollToSection(event, "#product")}>Product</a><a href="#pricing" onClick={(event) => scrollToSection(event, "#pricing")}>Pricing</a><a href="#security" onClick={(event) => scrollToSection(event, "#security")}>Security</a></div>
  <div className="nav-actions">
        <button className="mobile-nav-trigger" type="button" aria-label={mobileNavOpen ? "Close navigation menu" : "Open navigation menu"} aria-expanded={mobileNavOpen} aria-controls="landing-primary-links" onClick={() => setMobileNavOpen((open) => !open)}><span aria-hidden="true">{mobileNavOpen ? "×" : "☰"}</span></button>
        {signedIn ? (
          <Link className="btn btn-dark" href="/app">Open workspace</Link>
        ) : (
          <>
            <Link className="nav-text" href="/login">Sign in</Link>
            <Link className="btn btn-dark" href="/start-trial">Start free trial <span>↗</span></Link>
          </>
        )}
      </div>
</nav></div>

<main id="top">
<section className="hero">
  <canvas id="gravityCanvas" aria-hidden="true"></canvas>
  <div className="hero-copy">
    <div className="pill"><i></i> The knowledge is already there</div>
    <h1><span className="line">Someone knows how.</span><span className="line">Now <span className="hot">everyone can.</span></span></h1>
    <p className="lede">Every team has the person everyone asks. Knowhow turns the work they already do into living, step-by-step knowledge—without asking them to stop and document it.</p>
    <div className="hero-ctas"><Link className="btn btn-orange" href="/start-trial">Start free trial <span>→</span></Link><a className="btn btn-light magnetic" href="#how">See how it works <span>↓</span></a></div>
    <div className="hero-note">Browser capture · Editable before publishing · Built for IT & operations</div>
  </div>

  <div className="capture-comet" aria-hidden="true">
    <div className="trail t1"></div><div className="trail t2"></div><div className="trail t3"></div><div className="trail t4"></div>
    <div className="cursor-stack"><svg viewBox="0 0 70 82" fill="none"><path d="M10 5v60l15-14 11 24 12-6-11-23h22L10 5Z" fill="#ff5a12" stroke="#fff" strokeWidth="3" strokeLinejoin="round"/></svg></div>
    <div className="capture-chip"><span className="rec"><i></i></span><div><b>Recording workflow</b><span>Chrome · helpdesk.acme.io</span></div><em>12</em></div>
  </div>

  <div className="product-stage" aria-hidden="true">
    <div className="windowbar"><div className="lights"><i></i><i></i><i></i></div><div className="address">app.knowhow.so/guides/new-user</div><div className="tiny-avatar">YS</div></div>
    <div className="app">
      <aside className="side"><div className="side-logo"><span className="mini-logo">kh</span>knowhow</div>
        <div className="side-item active"><svg viewBox="0 0 24 24" fill="none"><path d="M4 5h16v14H4zM8 9h8M8 13h5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg> Guides</div>
        <div className="side-item"><svg viewBox="0 0 24 24" fill="none"><path d="M12 3v18M3 12h18" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg> Capture</div>
        <div className="side-item"><svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="6" stroke="currentColor" strokeWidth="1.7"/><path d="m16 16 4 4" stroke="currentColor" strokeWidth="1.7"/></svg> Search</div>
        <div className="side-label">Workspace</div><div className="side-item">IT Operations</div><div className="side-item">Service Desk</div><div className="side-item">Onboarding</div>
      </aside>
      <div className="work"><div className="workhead"><div><div className="crumb">Guides / Employee onboarding</div><h3>Set up a new Microsoft 365 user</h3><div className="sub">7 steps · Captured 2 minutes ago</div></div><div className="publish">Publish guide</div></div>
        <div className="guide"><div className="steps-list">
          <div className="step-row"><div className="num">01</div><div><b>Open Microsoft 365 admin center</b><p>Sign in with your administrator account.</p></div><div className="thumb"></div></div>
          <div className="step-row"><div className="num">02</div><div><b>Select Users, then Active users</b><p>Navigate from the left sidebar.</p></div><div className="thumb"></div></div>
          <div className="step-row"><div className="num">03</div><div><b>Choose “Add a user”</b><p>Enter the employee’s account details.</p></div><div className="thumb"></div></div>
          <div className="step-row"><div className="num">04</div><div><b>Assign licenses and permissions</b><p>Review before you finish.</p></div><div className="thumb"></div></div>
        </div><aside className="inspector"><h4>Step settings</h4><div className="field">Title · Assign licenses</div><div className="field">Instruction · Review permissions</div><div className="switch-row">Blur sensitive data <span className="switch"><i></i></span></div><div className="blur-preview"></div></aside></div>
      </div>
    </div>
  </div>
  <div className="product-fade"></div>
</section>

<section className="signal"><small>The questions your experts answer every week</small><div className="marquee"><div className="marquee-track">
  <div className="tag"><i>⌁</i>IT onboarding</div><div className="tag"><i>↗</i>Incident response</div><div className="tag"><i>◫</i>Help desk</div><div className="tag"><i>✓</i>Change management</div><div className="tag"><i>◎</i>Client handover</div><div className="tag"><i>⌘</i>Internal tools</div><div className="tag"><i>◇</i>Network ops</div>
</div><div className="marquee-track" aria-hidden="true">
  <div className="tag"><i>⌁</i>IT onboarding</div><div className="tag"><i>↗</i>Incident response</div><div className="tag"><i>◫</i>Help desk</div><div className="tag"><i>✓</i>Change management</div><div className="tag"><i>◎</i>Client handover</div><div className="tag"><i>⌘</i>Internal tools</div><div className="tag"><i>◇</i>Network ops</div>
</div></div></section>

<section className="prologue" id="story-start"><div className="prologue-sticky">
  <div className="prologue-noise"></div>
  <div className="prologue-head">
    <div className="chapter-mark">Chapter 01 · The person everyone asks</div>
    <h2><span id="prologueLine">Every team has that person.</span></h2>
    <p id="prologueSub">The one who remembers the weird fix, the hidden setting, the exact order that makes everything work.</p>
  </div>
  <div className="expert-world">
    <div className="expert-orbit" id="expertOrbit"></div>
    <div className="expert-card" id="expertCard">
      <div className="expert-avatar">YOU</div><small>the human runbook</small><h3>“Just ask me.”</h3><p>Somehow, the answer to every operational question lives here.</p>
      <div className="interruptions"><b id="interruptCount">0</b><span>repeat questions<br />this week</span></div>
    </div>
    <div className="ping p1"><i>IT</i><div><b>New message</b><span>How do I reset GlobalProtect again?</span></div><em></em></div>
    <div className="ping p2"><i>OP</i><div><b>Omar</b><span>Which VLAN do we use for guest Wi‑Fi?</span></div><em></em></div>
    <div className="ping p3"><i>HR</i><div><b>People Ops</b><span>Where’s the new-starter checklist?</span></div><em></em></div>
    <div className="ping p4"><i>SD</i><div><b>Service Desk</b><span>Can you show me the M365 flow?</span></div><em></em></div>
    <div className="ping p5"><i>NW</i><div><b>NOC</b><span>What’s the rollback process for this?</span></div><em></em></div>
    <div className="ping p6"><i>MS</i><div><b>Client team</b><span>Can you send the steps one more time?</span></div><em></em></div>
    <div className="record-answer" id="recordAnswer"><i>●</i><div><b>Answer it once.</b><span>Knowhow is capturing the work.</span></div></div>
  </div>
  <div className="story-prompt">scroll to follow the answer ↓</div>
</div></section>

<section className="narrative-bridge"><div className="inner">
  <div className="chapter-mark">Chapter 02 · A different answer</div>
  <h2>Don’t write the process.<br /><em>Do the process.</em></h2>
  <p>Instead of opening another blank document, start Knowhow and solve the problem exactly the way you normally would. The documentation begins as a side effect of real work.</p>
  <div className="answer-chip"><i>●</i><span>Capture started · the expert keeps working</span></div>
</div></section>

<section className="morph" id="morph"><div className="morph-sticky">
  <div className="morph-copy"><small>Chapter 03 · The work leaves a trail</small><h2>Six ordinary clicks.<br /><span id="morphWord">One teachable answer.</span></h2></div>
  <div className="morph-stage">
    <div className="morph-guide" id="morphGuide"><div className="mg-top"><b>New employee onboarding</b><span>Ready to publish</span></div><div className="mg-body"><div className="mg-eyebrow">Generated guide · 6 captured actions</div><h3>Create a Microsoft 365 user</h3>
      <div className="mg-step"><em>01</em><div><i></i><i></i></div><span className="mg-thumb"></span></div><div className="mg-step"><em>02</em><div><i></i><i></i></div><span className="mg-thumb"></span></div><div className="mg-step"><em>03</em><div><i></i><i></i></div><span className="mg-thumb"></span></div><div className="mg-step"><em>04</em><div><i></i><i></i></div><span className="mg-thumb"></span></div><div className="mg-step"><em>05</em><div><i></i><i></i></div><span className="mg-thumb"></span></div><div className="mg-step"><em>06</em><div><i></i><i></i></div><span className="mg-thumb"></span></div>
    </div></div>
    <div className="raw-shot" data-sx="-34" data-sy="-7" data-r="-15"><div className="shotbar"><i></i><i></i><i></i></div><div className="shotbody"><div className="shot-title"></div><div className="shot-line"></div><div className="shot-line"></div><div className="shot-btn"></div></div><span className="shot-pulse"></span></div>
    <div className="raw-shot" data-sx="-27" data-sy="19" data-r="9"><div className="shotbar"><i></i><i></i><i></i></div><div className="shotbody"><div className="shot-title"></div><div className="shot-line"></div><div className="shot-line"></div><div className="shot-btn"></div></div><span className="shot-pulse"></span></div>
    <div className="raw-shot" data-sx="-11" data-sy="28" data-r="-7"><div className="shotbar"><i></i><i></i><i></i></div><div className="shotbody"><div className="shot-title"></div><div className="shot-line"></div><div className="shot-line"></div><div className="shot-btn"></div></div><span className="shot-pulse"></span></div>
    <div className="raw-shot" data-sx="14" data-sy="27" data-r="12"><div className="shotbar"><i></i><i></i><i></i></div><div className="shotbody"><div className="shot-title"></div><div className="shot-line"></div><div className="shot-line"></div><div className="shot-btn"></div></div><span className="shot-pulse"></span></div>
    <div className="raw-shot" data-sx="29" data-sy="15" data-r="-9"><div className="shotbar"><i></i><i></i><i></i></div><div className="shotbody"><div className="shot-title"></div><div className="shot-line"></div><div className="shot-line"></div><div className="shot-btn"></div></div><span className="shot-pulse"></span></div>
    <div className="raw-shot" data-sx="35" data-sy="-8" data-r="14"><div className="shotbar"><i></i><i></i><i></i></div><div className="shotbody"><div className="shot-title"></div><div className="shot-line"></div><div className="shot-line"></div><div className="shot-btn"></div></div><span className="shot-pulse"></span></div>
  </div>
  <div className="morph-caption" id="morphCaption">No formatting marathon. No reconstructing it from memory. <strong>The answer is already taking shape.</strong></div>
</div></section>

<section className="story" id="how"><div className="story-sticky">
  <div className="story-glow"></div><div className="story-rings"></div>
  <div className="story-head"><div className="story-kicker">Chapter 04 · Turn experience into memory</div><h2>Knowhow remembers the useful parts.</h2><p>The expert stays in flow. Knowhow turns that one real run into something the next person can trust.</p></div>

  <article className="story-card scene1"><div className="story-card-inner"><div className="story-copy"><span className="count">01 / NOTICE</span><div><h3>It sees the work.</h3><p>The extension follows the real flow and keeps the meaningful actions, screens and destinations—not every twitch of the mouse.</p></div><span className="microcopy">One real task · captured in context</span></div><div className="story-visual"><div className="capture-line"></div><div className="capture-node n1">01</div><div className="capture-node n2">02</div><div className="capture-node n3">03</div><i className="beam-dot"></i></div></div></article>

  <article className="story-card scene2"><div className="story-card-inner"><div className="story-copy"><span className="count">02 / EXPLAIN</span><div><h3>Add the human part.</h3><p>Rename the odd step, add the “why,” swap a screenshot and blur what is private. A few seconds of judgment turns activity into guidance.</p></div><span className="microcopy">Expert context · privacy · one quick review</span></div><div className="story-visual"><div className="editor-shot"><div className="bar"></div><div className="doc"><b>Create a firewall change request</b><div className="fake-line"></div><div className="fake-line"></div><div className="fake-line"></div><div className="editor-img"></div></div></div><svg className="edit-cursor" viewBox="0 0 70 82" fill="none" aria-hidden="true"><path d="M10 5v60l15-14 11 24 12-6-11-23h22L10 5Z" fill="#ff5a12" stroke="#fff" strokeWidth="3" strokeLinejoin="round"/></svg></div></div></article>

  <article className="story-card scene3"><div className="story-card-inner"><div className="story-copy"><span className="count">03 / REMEMBER</span><div><h3>The team keeps the answer.</h3><p>Publish one living source of truth. The next technician can search it, follow it and get on with the job—without another interruption.</p></div><span className="microcopy">Searchable · reusable · still there tomorrow</span></div><div className="story-visual"><div className="publish-world"><i className="share-dot sd1"></i><i className="share-dot sd2"></i><i className="share-dot sd3"></i><div className="publish-doc"><h4>VPN access request</h4><div className="doc-step"><i></i><span></span></div><div className="doc-step"><i></i><span></span></div><div className="doc-step"><i></i><span></span></div><div className="doc-step"><i></i><span></span></div></div></div></div></div></article>

  <div className="story-progress"><i></i><i></i><i></i></div>
</div></section>

<section className="playground" id="demo"><div className="shell">
  <div className="play-head reveal"><div><div className="play-kicker">Chapter 05 · Now you&apos;re the expert</div><h2>Do the task.<br />Don&apos;t write the guide.</h2></div><div className="play-intro"><p>You&apos;re about to answer one tiny operational question. Follow the orange target and work normally. Watch what the next person receives.</p><div className="try-indicator"><i></i><span><b>Interactive demo</b> Click the pulsing target to begin</span><em>↘</em></div></div></div>
  <div className="play-shell reveal"><div className="play-grid">
    <div className="demo-browser"><div className="demo-chrome"><div className="demo-dots"><i></i><i></i><i></i></div><div className="demo-url">admin.acme.local / workspace / people</div><div className="demo-live"><i></i>CAPTURING</div></div>
      <div className="demo-app"><aside className="demo-side"><div className="demo-brand">ACME / admin</div><div className="demo-nav">Overview</div><button type="button" className={`demo-nav current demo-hotspot${demoStep === 1 ? " ready" : ""}`} data-label="capture" onClick={() => captureDemo(1)}>People<span className="hotspot-label">Click me</span></button><div className="demo-nav">Devices</div><div className="demo-nav">Security</div><div className="demo-nav">Settings</div></aside>
        <div className="demo-main"><div className="demo-bread">Workspace / People</div><h3>People</h3><p>Manage members, groups and access.</p><div className="demo-toolbar"><div className="demo-search">⌕ &nbsp; Search people</div><button type="button" className={`demo-add demo-hotspot${demoStep === 2 ? " ready" : ""}`} data-label="capture" onClick={() => captureDemo(2)}>+ Add member<span className="hotspot-label">Try this</span></button></div>
          <div className="demo-table"><div className="demo-row"><span>Name</span><span>Role</span><span>Status</span></div><div className="demo-row"><span className="person"><i></i>Yara Hassan</span><span className="role-pill">Admin</span><span>Active</span></div><div className="demo-row"><span className="person"><i></i>Omar Ali</span><span className="role-pill">Member</span><span>Active</span></div><div className="demo-row"><span className="person"><i></i>Nadia Karim</span><span className="role-pill">Member</span><span>Active</span></div></div>
          <div className={`demo-modal${demoStep >= 3 ? " show" : ""}`}><h4>Add a new member</h4><div className="demo-field">name@company.com</div><div className="demo-field">Full name</div><div className="demo-role">Workspace role <button type="button" className={`role-pill demo-hotspot${demoStep === 3 ? " ready" : ""}`} data-label="capture" onClick={() => captureDemo(3)}>Member ▾<span className="hotspot-label">Pick a role</span></button></div><button className="demo-save" type="button" onClick={() => demoStep > 3 && setDemoDone(true)}>Add member</button></div>
        </div>
      </div>
    </div>
    <aside className="capture-console"><div className="console-head"><div className="console-title"><b>Knowhow Capture</b><span>ACME admin · live session</span></div><div className="console-rec"><i></i></div></div><div className="console-status"><strong>{Math.min(demoStep - 1, 3)}</strong><span>meaningful actions<br />captured</span></div><div className="console-list">{captureDemoSteps.slice(0, Math.max(0, demoStep - 1)).map((step, index) => <div className="captured-step in" key={step.title}><em>0{index + 1}</em><div><b>{step.title}</b><small>{step.sub}</small></div></div>)}</div><div className="console-hint"><span>Next: <b>{demoStep <= 3 ? captureDemoSteps[demoStep - 1].hint : "finish the guide"}</b></span><button className="demo-reset" type="button" onClick={resetCaptureDemo}>Reset demo ↺</button></div>
      <div className={`console-done${demoDone ? " show" : ""}`}><div><div className="done-orbit"><div className="done-check">✓</div></div><h3>You just taught the next person.</h3><p>Three ordinary clicks became a reusable answer—without opening a document.</p><button type="button" onClick={resetCaptureDemo}>Run it again ↺</button></div></div>
    </aside>
  </div></div>
</div></section>

<section className="features" id="product"><div className="shell">
  <div className="section-head reveal"><div><div className="section-tag">Chapter 05 · The next morning</div><h2>This time, the answer is already there.</h2></div><p>What changed? Not the work. The interruption disappeared. The knowledge now belongs to the team instead of living in one person’s head.</p></div>
  <div className="bento">
    <article className="card one reveal"><h3>The expert keeps working.</h3><p>Capture preserves the actions that matter while the person who knows stays focused on solving the real problem.</p><div className="extension"><div className="site-mini"><div className="site-wires"><div className="wire-title"></div><div className="wire-copy"></div><div className="wire-copy" style={{ width: "62%" }}></div><div className="wire-button"></div><div className="wire-grid"><i></i><i></i></div></div></div><div className="click-target"></div><div className="ext-pop"><div className="ext-top"><b>Knowhow Capture</b><i className="live"></i></div><div className="ext-count">12</div><small>actions captured</small><div className="ext-btn">Finish & review</div></div></div></article>
        <article className="card two reveal" id="security"><h3>Private things stay private.</h3><p>The answer can travel without the secrets. Blur sensitive details before the guide becomes part of team memory.</p><div className="private-stage" role="region" aria-label="Privacy protection examples" tabIndex={0}><div className="privacy-panel"><div className="privacy-panel-head"><span className="privacy-icon">•••</span><em>ON</em></div><b>Password fields</b><span>Detected and hidden automatically</span><div className="privacy-field"><i></i><i></i><i></i><strong>Protected</strong></div><div className="privacy-status"><i></i>Live protection</div></div><div className="privacy-panel"><div className="privacy-panel-head"><span className="privacy-icon">Aa</span><em>READY</em></div><b>Account details</b><span>Choose anything sensitive before saving</span><div className="privacy-preview"><i></i><i></i><i></i><div className="privacy-mask">Blurred</div></div><div className="privacy-status"><i></i>Preview secured</div></div></div></article>
    <article className="card three reveal"><h3>The next person asks Knowhow.</h3><p>They search the question in their own words and land on the exact guide or step—without finding the expert first.</p><div className="search-ui"><div className="searchbar">⌕ &nbsp; how do I reset a VPN profile?</div><div className="result"><i></i><div><b>Reset a GlobalProtect VPN profile</b><span>Network Operations · 8 steps</span></div></div><div className="result"><i></i><div><b>Renew VPN certificate</b><span>Security · 5 steps</span></div></div><div className="result"><i></i><div><b>Offboard remote access</b><span>IT Onboarding · 6 steps</span></div></div></div></article>
    <article className="card four reveal"><h3>The answer survives the person.</h3><p>People change teams. Vendors rotate. Clients hand over. The operating memory stays available to whoever comes next.</p><div className="team-stage"><div className="orbit-team"><div className="avatar a1">L1</div><div className="avatar a2">OPS</div><div className="avatar a3">NOC</div><div className="avatar a4">MSP</div><div className="team-core">knowhow<i></i></div></div></div></article>
  </div>
</div></section>


<section className="pricing-story" id="pricing">
  <div className="pricing-inner">
    <div className="pricing-head reveal">
      <div className="chapter-mark">Chapter 06 · Start where you are</div>
      <h2>Start small.<br /><span>Pay for scale, not status.</span></h2>
      <p>Start free, move to Pro when the team needs the full workflow, and move to Enterprise only when you need more usage or hands-on provisioning. The core Pro product stays the same.</p>
      <div className="pricing-path" aria-hidden="true"><div className="path-stop active"><i></i>Start</div><div className="path-line"></div><div className="path-stop"><i></i>Team</div><div className="path-line"></div><div className="path-stop"><i></i>Organization</div></div>
    </div>

    {pricingPlans}
    <div className="pricing-after reveal"><div><b>The model stays simple.</b><span>Free, Pro and Enterprise are available as SaaS. Enterprise can also be provisioned on-premises when the environment requires it.</span></div><a className="mini-link" href="#product">See what every plan is built around ↗</a></div>
  </div>
</section>

<section className="payoff-strip">
  <div className="chapter-mark">Chapter 07 · The payoff</div>
  <h2>One person knew how.<br /><span>Now the team does.</span></h2>
  <p>Knowhow turns individual experience into shared operating memory—one real task at a time.</p>
  <div className="payoff-network" aria-hidden="true"><div className="knowledge-line"></div><div className="person-node n0">EXPERT</div><div className="person-node n1">L1</div><div className="person-node n2">OPS</div><div className="person-node n3">NEW HIRE</div><div className="person-node n4">CLIENT</div><div className="knowledge-core">knowhow</div></div>
</section>

<section className="final" id="start"><div className="final-panel"><canvas className="final-canvas" id="finalCanvas" aria-hidden="true"></canvas><div className="final-content"><div className="final-kicker">The story can start with your next task</div><h2>Answer it once.<br />Keep it forever.</h2><p>Your team already has the know-how. Capture the next real process and make sure the answer is there before anyone has to ask again.</p><div className="final-actions"><Link className="btn btn-orange" href="/start-trial">Start free trial <span>→</span></Link><a className="btn btn-light magnetic" href="#product">Explore product</a></div><div className="final-note">No credit card · Capture stays on Pro</div></div></div></section>
</main>

<footer>
      <div className="footer-inner">
        <a className="logo" href="#top"><span className="logo-mark"><BrandMarkGlyph size={16} /></span>knowhow</a>
        <nav className="footer-links" aria-label="Footer navigation">
          <Link href="/#how">How it works</Link>
          <Link href="/#product">Product</Link>
          <Link href="/#pricing">Pricing</Link>
          <Link href="/extension">Extension</Link>
          <Link href="/contact">Support</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
        </nav>
        <div className="footer-copy">© 2026 KnowHow</div>
      </div>
    </footer>


    </div>
  );
}
