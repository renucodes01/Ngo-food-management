
const API_BASE = "http://localhost:8080/api"; // Spring Boot backend
const BACKEND_DOWN_KEY = "fs_backend_down_until";

// ---------- Helper: fetch wrapper (falls back to local demo data) ----------
async function apiRequest(path, method = "GET", body = null, auth = false) {
 
  const downUntil = Number(sessionStorage.getItem(BACKEND_DOWN_KEY)) || 0;
  if (Date.now() < downUntil) {
    return mockApi(path, method, body, auth);
  }
  try {
    return await realApiRequest(path, method, body, auth);
  } catch (err) {
    sessionStorage.setItem(BACKEND_DOWN_KEY, String(Date.now() + 30000));
    return mockApi(path, method, body, auth);
  }
}

async function realApiRequest(path, method, body, auth) {
  const headers = { "Content-Type": "application/json" };
  if (auth) {
    const token = localStorage.getItem("fs_token");
    if (token) headers["Authorization"] = "Bearer " + token;
  }
  const controller = new AbortController();
  // Short timeout — the real backend, when it's running, responds almost
  // instantly on localhost. No need to make the page wait seconds for it.
  const timeout = setTimeout(() => controller.abort(), 900);
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : null,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || "Something went wrong");
  return data;
}

// ---------- Local demo "backend" (localStorage-based, used when the real
// Spring Boot / MongoDB backend isn't reachable, e.g. for offline demos) ----------
function lsGet(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; }
}
function lsSet(key, value) { localStorage.setItem(key, JSON.stringify(value)); }

function seedDemoAdmin() {
  const users = lsGet("fs_local_users", []);
  if (!users.some((u) => u.role === "admin")) {
    users.push({ id: "admin-seed", name: "FoodShare Admin", email: "admin@foodshare.org", password: "admin123", role: "admin" });
    lsSet("fs_local_users", users);
  }
}

function mockApi(path, method, body, auth) {
  const users = lsGet("fs_local_users", []);
  const foods = lsGet("fs_local_food", []);

  const currentUser = () => {
    const token = localStorage.getItem("fs_token") || "";
    if (!token.startsWith("local-")) return null;
    return users.find((u) => u.id === token.replace("local-", ""));
  };

  // ---- Auth ----
  if (path === "/auth/register" && method === "POST") {
    if (users.some((u) => u.email.toLowerCase() === body.email.toLowerCase())) {
      throw new Error("Email already registered.");
    }
    const id = "u" + Date.now();
    const user = { id, name: body.name, email: body.email, password: body.password, role: body.role };
    users.push(user);
    lsSet("fs_local_users", users);
    return { token: "local-" + id, role: user.role, name: user.name };
  }

  if (path === "/auth/login" && method === "POST") {
    const user = users.find(
      (u) => u.email.toLowerCase() === body.email.toLowerCase() && u.password === body.password
    );
    if (!user) throw new Error("Invalid email or password.");
    return { token: "local-" + user.id, role: user.role, name: user.name };
  }

  // ---- Food listings ----
  if (path === "/food" && method === "GET") {
    return foods.map((f) => ({ ...f }));
  }

  if (path === "/food" && method === "POST") {
    const donor = currentUser();
    if (!donor) throw new Error("Please login as a Donor first.");
    const hours = Number(body.expiryHours) || 0;
    const item = {
      id: "f" + Date.now(),
      title: body.title,
      category: body.category,
      servings: body.servings,
      weightKg: body.weightKg,
      pickupAddress: body.pickupAddress,
      imageUrl: body.imageUrl || null,
      expiryHours: hours,
      expiryAt: Date.now() + hours * 60 * 60 * 1000,
      expiryText: hours + "h",
      donorName: donor.name,
      claimed: false,
    };
    foods.push(item);
    lsSet("fs_local_food", foods);
    return item;
  }

  const claimMatch = path.match(/^\/food\/(.+)\/claim$/);
  if (claimMatch && method === "PUT") {
    const ngo = currentUser();
    if (!ngo) throw new Error("Please login as an NGO first.");
    const item = foods.find((f) => f.id === claimMatch[1]);
    if (!item) throw new Error("This listing isn't in local demo data (it's one of the sample cards) — try claiming a listing you posted via Donate Food.");
    if (item.claimed) throw new Error("This listing is already claimed.");
    item.claimed = true;
    item.claimedBy = ngo.name;
    item.claimedByUserId = ngo.id;
    item.deliveryMethod = (body && body.deliveryMethod) || "pickup";
    item.ngoAddress = (body && body.ngoAddress) || "";
    item.status = "claimed";
    item.claimedAt = Date.now();
    lsSet("fs_local_food", foods);
    return item;
  }

  throw new Error("Not available in local demo mode.");
}

// ---------- Expiry helpers ----------
// A listing is "expired" once its donor-set safe window (expiryAt) has
// passed, unless it's already been claimed (claimed items follow the
// delivery flow instead) or an admin has manually force-expired it.
function isFoodExpired(item) {
  if (item.claimed) return false;
  if (item.manualExpired) return true;
  return !!(item.expiryAt && Date.now() > item.expiryAt);
}

function remainingTimeText(item) {
  if (!item.expiryAt) return item.expiryText || "—";
  const ms = item.expiryAt - Date.now();
  if (ms <= 0) return "Expired";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ---------- Role toggle (Login/Register pages) ----------
function initRoleCards() {
  const roleCards = document.querySelectorAll(".role-card");
  roleCards.forEach((card) => {
    card.addEventListener("click", () => {
      roleCards.forEach((c) => c.classList.remove("selected"));
      card.classList.add("selected");
      document.getElementById("selectedRole").value = card.dataset.role;
    });
  });
}

// ---------- Filter pills (Find Food page) ----------
function initFilterPills() {
  document.querySelectorAll("[data-filter-group]").forEach((group) => {
    const pills = group.querySelectorAll(".filter-pill");
    pills.forEach((pill) => {
      pill.addEventListener("click", () => {
        pills.forEach((p) => p.classList.remove("active", "soft"));
        pill.classList.add("active", "soft");
        filterFoodCards();
      });
    });
  });

  // "Hide expired & claimed" is an independent on/off toggle, not part of
  // the category filter group above.
  const hidePill = document.getElementById("hideExpiredPill");
  if (hidePill) {
    hidePill.addEventListener("click", () => {
      hidePill.classList.toggle("active");
      hidePill.classList.toggle("soft");
      filterFoodCards();
    });
  }
}

function filterFoodCards() {
  const activeType = document.querySelector('[data-filter-group="type"] .active')?.dataset.value || "All";
  const hideExpired = document.getElementById("hideExpiredPill")?.classList.contains("active");
  const cards = document.querySelectorAll(".food-card");
  let visibleCount = 0;
  cards.forEach((card) => {
    const type = card.dataset.type;
    const status = card.dataset.status || "active";
    const typeMatch = activeType === "All" || activeType === type;
    const statusMatch = !hideExpired || status === "active";
    const show = typeMatch && statusMatch;
    card.closest(".food-col").style.display = show ? "block" : "none";
    if (show) visibleCount++;
  });
  // Hide a category section entirely if it has no visible cards left
  document.querySelectorAll(".food-category-section").forEach((section) => {
    const hasVisible = [...section.querySelectorAll(".food-col")].some(
      (col) => col.style.display !== "none"
    );
    section.style.display = hasVisible ? "block" : "none";
  });
  const countLabel = document.getElementById("foodCountLabel");
  if (countLabel) countLabel.innerHTML = `Showing <strong>${visibleCount}</strong> listing${visibleCount === 1 ? "" : "s"}`;
}

// ---------- Login ----------
async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById("loginEmail").value;
  const password = document.getElementById("loginPassword").value;
  const role = document.getElementById("selectedRole").value;
  const errEl = document.getElementById("authError");
  try {
    const data = await apiRequest("/auth/login", "POST", { email, password, role });
    localStorage.setItem("fs_token", data.token);
    localStorage.setItem("fs_role", data.role);
    localStorage.setItem("fs_name", data.name);
    window.location.href = "find-food.html";
  } catch (err) {
    if (errEl) {
      errEl.textContent = err.message;
      errEl.style.display = "block";
    }
  }
}

// ---------- Register ----------
async function handleRegister(e) {
  e.preventDefault();
  const name = document.getElementById("regName").value;
  const email = document.getElementById("regEmail").value;
  const password = document.getElementById("regPassword").value;
  const role = document.getElementById("selectedRole").value;
  const errEl = document.getElementById("authError");
  try {
    const data = await apiRequest("/auth/register", "POST", { name, email, password, role });
    localStorage.setItem("fs_token", data.token);
    localStorage.setItem("fs_role", data.role);
    localStorage.setItem("fs_name", data.name);
    window.location.href = "find-food.html";
  } catch (err) {
    if (errEl) {
      errEl.textContent = err.message;
      errEl.style.display = "block";
    }
  }
}

// ---------- Food detail / claim modal ----------
let currentModalFood = null;
let selectedDeliveryMethod = null;

function setDeliveryMethod(method) {
  selectedDeliveryMethod = method;
  document.querySelectorAll(".fdm-delivery-opt").forEach((btn) => {
    btn.classList.toggle("selected", btn.dataset.method === method);
  });
  const addressWrap = document.getElementById("fdmNgoAddressWrap");
  const addressInput = document.getElementById("fdmNgoAddress");
  addressWrap.style.display = method === "volunteer" ? "block" : "none";
  if (method !== "volunteer") addressInput.value = "";

  const claimBtn = document.getElementById("fdmClaimBtn");
  if (claimBtn && !claimBtn.dataset.locked) {
    claimBtn.disabled = false;
    claimBtn.textContent = method === "volunteer" ? "Request volunteer delivery" : "Confirm self pickup";
  }
}

function openFoodModal(data) {
  currentModalFood = data;
  selectedDeliveryMethod = null;
  const fdmImgEl = document.getElementById("fdmImg");
  fdmImgEl.onerror = () => {
    fdmImgEl.onerror = null;
    fdmImgEl.src = 'https://images.unsplash.com/photo-1512058564366-18510be2db19?q=80&w=600';
  };
  fdmImgEl.src = data.img;
  document.getElementById("fdmTitle").textContent = data.title;
  document.getElementById("fdmDonor").textContent = `${data.donor} · ${data.donorType}`;
  document.getElementById("fdmServings").textContent = data.servings;
  document.getElementById("fdmWeight").textContent = data.weight;
  document.getElementById("fdmDistance").textContent = data.distance;
  document.getElementById("fdmAddress").textContent = data.address;
  document.getElementById("fdmExpiry").textContent = data.expiry;

  const msgEl = document.getElementById("fdmMsg");
  const claimBtn = document.getElementById("fdmClaimBtn");
  const deliverySection = document.getElementById("fdmDeliverySection");
  const addressWrap = document.getElementById("fdmNgoAddressWrap");
  const addressInput = document.getElementById("fdmNgoAddress");
  msgEl.textContent = "";
  msgEl.className = "small mb-2";
  claimBtn.dataset.locked = "";
  addressWrap.style.display = "none";
  addressInput.value = "";
  document.querySelectorAll(".fdm-delivery-opt").forEach((btn) => btn.classList.remove("selected"));

  const role = localStorage.getItem("fs_role");
  if (!localStorage.getItem("fs_token")) {
    deliverySection.style.display = "none";
    claimBtn.disabled = false;
    claimBtn.textContent = "Login to claim this food";
  } else if (role !== "ngo") {
    deliverySection.style.display = "none";
    claimBtn.disabled = true;
    claimBtn.textContent = "Only NGOs can claim food";
  } else {
    deliverySection.style.display = "block";
    claimBtn.disabled = true;
    claimBtn.textContent = "Choose a collection method above";
  }
}

async function claimFoodFromModal() {
  if (!currentModalFood) return;
  const msgEl = document.getElementById("fdmMsg");
  const claimBtn = document.getElementById("fdmClaimBtn");

  if (!localStorage.getItem("fs_token")) {
    window.location.href = "login.html";
    return;
  }
  if (localStorage.getItem("fs_role") !== "ngo") return;
  if (!selectedDeliveryMethod) return;

  let ngoAddress = "";
  if (selectedDeliveryMethod === "volunteer") {
    ngoAddress = document.getElementById("fdmNgoAddress").value.trim();
    if (!ngoAddress) {
      msgEl.textContent = "Please enter your NGO's delivery address.";
      msgEl.className = "small mb-2 text-danger fw-bold";
      return;
    }
  }

  try {
    await apiRequest(
      `/food/${currentModalFood.id}/claim`,
      "PUT",
      { deliveryMethod: selectedDeliveryMethod, ngoAddress },
      true
    );
    msgEl.textContent =
      selectedDeliveryMethod === "volunteer"
        ? "Claimed! A volunteer will pick this up and deliver it to your NGO address — free, no shipping cost."
        : "Claimed! Head to the pickup address before the safe window closes.";
    msgEl.className = "small mb-2 text-green fw-bold";
    claimBtn.disabled = true;
    claimBtn.dataset.locked = "1";
    claimBtn.textContent = "Claimed ✓";
  } catch (err) {
    msgEl.textContent = err.message || "This listing may already be claimed, or the demo card has no live backend record.";
    msgEl.className = "small mb-2 text-danger fw-bold";
  }
}

// ---------- Load live food listings (Find Food page) ----------
async function loadFoodListings() {
  const grid = document.getElementById("foodGrid");
  if (!grid) return;
  try {
    const listings = await apiRequest("/food");
    if (!listings.length) return; // keep static demo cards if backend empty

    const categoryIcons = {
      "Cooked Meals": "🍛",
      "Bakery": "🥖",
      "Raw Produce": "🥦",
      "Event Catering": "🎉",
      "Packaged": "📦",
    };
    const categoryOrder = Object.keys(categoryIcons);

    // Group listings by category
    const grouped = {};
    listings.forEach((item) => {
      const cat = item.category || "Packaged";
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(item);
    });

    grid.innerHTML = "";
    // Render known categories first in a fixed order, then any leftover categories
    const orderedCats = [...categoryOrder, ...Object.keys(grouped).filter((c) => !categoryOrder.includes(c))];

    orderedCats.forEach((cat) => {
      const items = grouped[cat];
      if (!items || !items.length) return;
      const icon = categoryIcons[cat] || "🍽️";
      const cardsHtml = items.map((item) => {
        const img = item.imageUrl || 'https://images.unsplash.com/photo-1512058564366-18510be2db19?q=80&w=600';
        const expired = isFoodExpired(item);
        const status = item.claimed ? "claimed" : expired ? "expired" : "active";
        const timeLeft = remainingTimeText(item);
        const modalData = {
          id: item.id, title: item.title, donor: item.donorName, donorType: item.category,
          img, servings: item.servings, weight: item.weightKg,
          distance: item.distanceText || '—', expiry: `Expires in ${timeLeft}`,
          address: item.pickupAddress || 'Address shared after claim'
        };

        let badge = "";
        let cardStyle = "";
        let buttonHtml = `<button type="button" class="btn-fs-primary w-100 mt-2 justify-content-center"
              data-bs-toggle="modal" data-bs-target="#foodDetailModal"
              onclick='openFoodModal(${JSON.stringify(modalData)})'>View Details</button>`;

        if (status === "claimed") {
          badge = `<span class="badge-pill" style="position:absolute;top:10px;right:10px;background:#eaf5ea;color:#2e7d32;">✅ Claimed</span>`;
          cardStyle = 'style="position:relative;opacity:0.65;"';
          buttonHtml = `<button type="button" class="btn-fs-outline w-100 mt-2 justify-content-center" disabled>Already Claimed</button>`;
        } else if (status === "expired") {
          badge = `<span class="badge-pill" style="position:absolute;top:10px;right:10px;background:#fdecec;color:#c0392b;">⏰ Expired</span>`;
          cardStyle = 'style="position:relative;opacity:0.65;"';
          buttonHtml = `<button type="button" class="btn-fs-outline w-100 mt-2 justify-content-center" disabled>Safe Window Closed</button>`;
        }

        return `
          <div class="col-md-4 food-col">
            <div class="food-card" data-type="${item.category}" data-status="${status}" ${cardStyle}>
              ${badge}
              <img src="${img}" alt="${item.title}" onerror="this.onerror=null;this.src='https://images.unsplash.com/photo-1512058564366-18510be2db19?q=80&w=600';">
              <div class="fc-body">
                <h6>${item.title}</h6>
                <div class="fc-sub">${item.donorName} · ${item.category}</div>
                <div class="fc-meta">
                  <span>👥 ${item.servings} servings</span>
                  <span>🥡 ${item.weightKg} kg</span>
                </div>
                <div class="fc-expiry">${status === "expired" ? "Expired" : "Expires in " + timeLeft}</div>
                ${buttonHtml}
              </div>
            </div>
          </div>`;
      }).join("");

      grid.innerHTML += `
        <div class="food-category-section" data-category="${cat}">
          <h6 class="fw-bold mb-3 mt-2">${icon} ${cat}</h6>
          <div class="row g-4 mb-4">${cardsHtml}</div>
        </div>`;
    });
    filterFoodCards(); // re-apply current filters + "hide expired & claimed" + update count
    fadeInCards(grid);
  } catch (err) {
    console.log("Backend not reachable, showing demo listings.", err.message);
  }
}

// Small helper: fades newly-inserted .food-card elements in smoothly instead
// of them popping into view abruptly when a grid is re-rendered.
function fadeInCards(container) {
  const cards = container.querySelectorAll(".food-card");
  cards.forEach((c) => { c.style.opacity = "0"; });
  requestAnimationFrame(() => {
    cards.forEach((c) => { c.style.opacity = "1"; });
  });
}

// ---------- Live Now preview (Home page) ----------
async function loadLiveNow() {
  const grid = document.getElementById("liveNowGrid");
  if (!grid) return; // not on the home page
  try {
    const listings = await apiRequest("/food");
    // Only truly live listings: not claimed, not expired
    const active = listings.filter((item) => !item.claimed && !isFoodExpired(item));

    if (!active.length) {
      // Nothing genuinely available right now — say so instead of showing
      // old sample cards that don't reflect reality.
      grid.innerHTML = `
        <div class="col-12 text-center py-4">
          <div style="font-size:2.2rem;">🍽️</div>
          <h6 class="fw-bold mt-2 mb-1">Nothing available right now</h6>
          <p class="text-muted small mb-3">All current listings have been claimed or expired. Check back soon, or be the first to post one.</p>
          <a href="donate-food.html" class="btn-fs-primary d-inline-flex">Donate Food</a>
        </div>`;
      fadeInCards(grid);
      return;
    }

    // Soonest-expiring first, so the most urgent food is shown first
    active.sort((a, b) => (a.expiryAt || Infinity) - (b.expiryAt || Infinity));
    const top3 = active.slice(0, 3);

    grid.innerHTML = top3.map((item) => {
      const img = item.imageUrl || 'https://images.unsplash.com/photo-1512058564366-18510be2db19?q=80&w=600';
      return `
        <div class="col-md-4 food-col">
          <div class="food-card">
            <img src="${img}" alt="${item.title}" onerror="this.onerror=null;this.src='https://images.unsplash.com/photo-1512058564366-18510be2db19?q=80&w=600';">
            <div class="fc-body">
              <h6>${item.title}</h6>
              <div class="fc-sub">${item.donorName} · ${item.category}</div>
              <div class="fc-meta"><span>👥 ${item.servings} servings</span><span>🥡 ${item.weightKg} kg</span></div>
              <div class="fc-expiry">Expires in ${remainingTimeText(item)}</div>
            </div>
          </div>
        </div>`;
    }).join("");
    fadeInCards(grid);
  } catch (err) {
    console.log("Backend not reachable, showing sample listings on home page.", err.message);
  }
}

// ---------- Donate food form submit ----------
function checkDonorAccess() {
  const form = document.getElementById("donateForm");
  if (!form) return; // not on the donate-food page
  const notice = document.getElementById("donorLoginNotice");
  const role = localStorage.getItem("fs_role");
  const token = localStorage.getItem("fs_token");
  if (token && role === "donor") {
    form.style.display = "block";
  } else {
    notice.style.display = "block";
  }
}

async function handleDonateSubmit(e) {
  e.preventDefault();
  const payload = {
    title: document.getElementById("foodTitle").value,
    category: document.getElementById("foodCategory").value,
    servings: document.getElementById("foodServings").value,
    weightKg: document.getElementById("foodWeight").value,
    pickupAddress: document.getElementById("foodAddress").value,
    expiryHours: document.getElementById("foodExpiry").value,
    imageUrl: document.getElementById("foodImage").value || undefined,
  };
  const msgEl = document.getElementById("donateMsg");
  try {
    await apiRequest("/food", "POST", payload, true);
    msgEl.textContent = "Food listed successfully! NGOs nearby will be notified.";
    msgEl.className = "text-green fw-bold mt-3";
    e.target.reset();
  } catch (err) {
    msgEl.textContent = err.message || "Please login as a Donor first.";
    msgEl.className = "text-danger fw-bold mt-3";
  }
}

// ---------- Navbar auth state ----------
function updateNavAuth() {
  const name = localStorage.getItem("fs_name");
  const authSlot = document.getElementById("navAuthSlot");
  if (name && authSlot) {
    authSlot.innerHTML = `
      <span class="fw-semibold me-3">Hi, ${name}</span>
      <button class="btn-fs-outline" onclick="logout()">Logout</button>`;
  }
}
function logout() {
  localStorage.removeItem("fs_token");
  localStorage.removeItem("fs_role");
  localStorage.removeItem("fs_name");
  window.location.href = "index.html";
}

// ---------- My Claims / order tracking ----------
const PICKUP_STEPS = [
  { key: "claimed", label: "Claimed", icon: "✅" },
  { key: "picked_up", label: "Picked Up", icon: "🚶" },
];
const VOLUNTEER_STEPS = [
  { key: "claimed", label: "Claimed", icon: "✅" },
  { key: "assigned", label: "Volunteer Assigned", icon: "🙋" },
  { key: "out_for_delivery", label: "Out for Delivery", icon: "🚴" },
  { key: "delivered", label: "Delivered", icon: "📦" },
  { key: "received", label: "Received", icon: "📥" },
];
// Steps in the volunteer flow that only Admin can advance (assigning + delivery
// tracking). "received" stays with the NGO as their final confirmation.
const ADMIN_CONTROLLED_STEPS = ["assigned", "out_for_delivery", "delivered"];
// Current statuses that still need an Admin action (i.e. everything up to,
// but not including, "delivered" — after that it's the NGO's turn to confirm).
const ADMIN_ACTIONABLE_STATUSES = ["claimed", "assigned", "out_for_delivery"];

function renderMyClaims() {
  const listEl = document.getElementById("claimsList");
  if (!listEl) return; // not on the My Claims page
  const notNgo = document.getElementById("notNgoNotice");
  const empty = document.getElementById("emptyNotice");

  const token = localStorage.getItem("fs_token");
  const role = localStorage.getItem("fs_role");
  if (!token || role !== "ngo") {
    notNgo.style.display = "block";
    return;
  }

  const users = lsGet("fs_local_users", []);
  const myId = token.startsWith("local-") ? token.replace("local-", "") : null;
  const foods = lsGet("fs_local_food", []);
  const myClaims = foods
    .filter((f) => f.claimed && (f.claimedByUserId === myId || !myId))
    .sort((a, b) => (b.claimedAt || 0) - (a.claimedAt || 0));

  if (!myClaims.length) {
    empty.style.display = "block";
    return;
  }

  listEl.innerHTML = myClaims.map((item) => claimCardHtml(item)).join("");
}

function claimCardHtml(item) {
  const steps = item.deliveryMethod === "volunteer" ? VOLUNTEER_STEPS : PICKUP_STEPS;
  const currentIndex = steps.findIndex((s) => s.key === item.status);
  const isFinal = currentIndex === steps.length - 1;
  const nextStepKey = !isFinal ? steps[currentIndex + 1].key : null;
  const nextIsAdminControlled = nextStepKey && ADMIN_CONTROLLED_STEPS.includes(nextStepKey);

  const stepsHtml = steps
    .map((s, i) => {
      const state = i < currentIndex ? "done" : i === currentIndex ? "current" : "upcoming";
      return `
        <div class="track-step track-${state}">
          <div class="track-icon">${s.icon}</div>
          <div class="track-label">${s.label}</div>
        </div>`;
    })
    .join('<div class="track-connector"></div>');

  let nextBtn;
  if (isFinal) {
    nextBtn = `<span class="text-green fw-bold small">✓ Complete</span>`;
  } else if (nextIsAdminControlled) {
    const waitingText =
      nextStepKey === "assigned"
        ? "⏳ Waiting for Admin to assign a volunteer for this delivery."
        : `⏳ Waiting for Admin to mark this as "${steps[currentIndex + 1].label}".`;
    nextBtn = `
      <div class="mt-3 p-3 text-center" style="background:var(--green-bg,#f4f9f4);border-radius:10px;">
        <div class="small text-muted">${waitingText}</div>
      </div>`;
  } else {
    nextBtn = `<button type="button" class="btn-fs-outline mt-3" onclick="advanceClaimStatus('${item.id}')">Mark as "${steps[currentIndex + 1].label}"</button>`;
  }

  const volunteerInfo = item.volunteerName
    ? `<div class="small text-muted mt-2">🙋 Volunteer: <strong>${item.volunteerName}</strong> · 📞 ${item.volunteerPhone || ""}</div>`
    : "";
  const ngoAddressInfo = item.deliveryMethod === "volunteer" && item.ngoAddress
    ? `<div class="small text-muted mt-1">🏠 Delivering to: ${item.ngoAddress}</div>`
    : "";

  return `
    <div class="card-fs mb-3">
      <div class="d-flex justify-content-between align-items-start mb-2">
        <div>
          <h6 class="fw-bold mb-0">${item.title}</h6>
          <div class="text-muted small">${item.donorName} · ${item.pickupAddress || ""}</div>
        </div>
        <span class="badge-pill">${item.deliveryMethod === "volunteer" ? "Volunteer Delivery" : "Self Pickup"}</span>
      </div>
      <div class="track-row">${stepsHtml}</div>
      ${ngoAddressInfo}
      ${volunteerInfo}
      ${nextBtn}
    </div>`;
}

function volunteerDeliveryCardHtml(f) {
  const infoHeader = `
    <div class="d-flex justify-content-between align-items-start mb-2">
      <div>
        <div class="fw-semibold small">${f.title}</div>
        <div class="text-muted small">Claimed by ${f.claimedBy} · Pickup from: ${f.pickupAddress || ""}</div>
        <div class="text-muted small">🏠 Deliver to (NGO address): <strong>${f.ngoAddress || "—"}</strong></div>
      </div>
      <span class="badge-pill">${f.status === "claimed" ? "⏳ Needs volunteer" : f.status === "assigned" ? "🙋 Assigned" : "🚴 Out for delivery"}</span>
    </div>`;

  if (f.status === "claimed") {
    return `
      <div class="p-3 mb-2" style="background:var(--green-bg,#f4f9f4);border-radius:10px;">
        ${infoHeader}
        <input type="text" class="form-control-fs mb-2" id="volName-${f.id}" placeholder="Volunteer name">
        <input type="tel" class="form-control-fs mb-2" id="volPhone-${f.id}" placeholder="Volunteer phone number">
        <button type="button" class="btn-fs-primary w-100 justify-content-center" onclick="adminAssignVolunteer('${f.id}')">Assign volunteer</button>
      </div>`;
  }

  const volunteerLine = `<div class="text-muted small mb-2">🙋 Volunteer: <strong>${f.volunteerName}</strong> · 📞 ${f.volunteerPhone}</div>`;

  if (f.status === "assigned") {
    return `
      <div class="p-3 mb-2" style="background:var(--green-bg,#f4f9f4);border-radius:10px;">
        ${infoHeader}
        ${volunteerLine}
        <button type="button" class="btn-fs-primary w-100 justify-content-center" onclick="adminMarkOutForDelivery('${f.id}')">Mark as Out for Delivery</button>
      </div>`;
  }

  // status === "out_for_delivery"
  return `
    <div class="p-3 mb-2" style="background:var(--green-bg,#f4f9f4);border-radius:10px;">
      ${infoHeader}
      ${volunteerLine}
      <button type="button" class="btn-fs-primary w-100 justify-content-center" onclick="adminMarkDelivered('${f.id}')">Mark as Delivered</button>
    </div>`;
}

function adminMarkOutForDelivery(itemId) {
  const foods = lsGet("fs_local_food", []);
  const item = foods.find((f) => f.id === itemId);
  if (!item) return;
  item.status = "out_for_delivery";
  lsSet("fs_local_food", foods);
  renderAdminDashboard();
}

function adminMarkDelivered(itemId) {
  const foods = lsGet("fs_local_food", []);
  const item = foods.find((f) => f.id === itemId);
  if (!item) return;
  item.status = "delivered";
  lsSet("fs_local_food", foods);
  renderAdminDashboard();
}

function adminAssignVolunteer(itemId) {
  const nameInput = document.getElementById(`volName-${itemId}`);
  const phoneInput = document.getElementById(`volPhone-${itemId}`);
  const name = nameInput.value.trim();
  const phone = phoneInput.value.trim();
  if (!name || !phone) {
    alert("Please enter both the volunteer's name and phone number.");
    return;
  }
  const foods = lsGet("fs_local_food", []);
  const item = foods.find((f) => f.id === itemId);
  if (!item) return;
  item.volunteerName = name;
  item.volunteerPhone = phone;
  item.status = "assigned";
  lsSet("fs_local_food", foods);
  renderAdminDashboard();
}

function advanceClaimStatus(itemId) {
  const foods = lsGet("fs_local_food", []);
  const item = foods.find((f) => f.id === itemId);
  if (!item) return;
  const steps = item.deliveryMethod === "volunteer" ? VOLUNTEER_STEPS : PICKUP_STEPS;
  const currentIndex = steps.findIndex((s) => s.key === item.status);
  if (currentIndex < steps.length - 1) {
    item.status = steps[currentIndex + 1].key;
    lsSet("fs_local_food", foods);
  }
  renderMyClaims();
}

function adminMarkExpired(itemId) {
  const foods = lsGet("fs_local_food", []);
  const item = foods.find((f) => f.id === itemId);
  if (!item) return;
  if (item.claimed) return; // claimed items follow the delivery flow, not expiry
  item.manualExpired = true;
  lsSet("fs_local_food", foods);
  renderAdminDashboard();
  loadFoodListings();
}

function adminUnmarkExpired(itemId) {
  const foods = lsGet("fs_local_food", []);
  const item = foods.find((f) => f.id === itemId);
  if (!item) return;
  item.manualExpired = false;
  // Give it a fresh 1-hour window so it doesn't instantly re-expire.
  item.expiryAt = Date.now() + 60 * 60 * 1000;
  lsSet("fs_local_food", foods);
  renderAdminDashboard();
  loadFoodListings();
}

function adminClearExpired() {
  const foods = lsGet("fs_local_food", []);
  const remaining = foods.filter((f) => !(isFoodExpired(f) && !f.claimed));
  lsSet("fs_local_food", remaining);
  renderAdminDashboard();
  loadFoodListings();
  loadLiveNow();
}

// ---------- Admin dashboard ----------
function renderAdminDashboard() {
  const content = document.getElementById("adminContent");
  if (!content) return; // not on the admin page
  const notice = document.getElementById("notAdminNotice");

  const role = localStorage.getItem("fs_role");
  if (role !== "admin") {
    notice.style.display = "block";
    return;
  }
  content.style.display = "block";

  const users = lsGet("fs_local_users", []);
  const foods = lsGet("fs_local_food", []);
  const donors = users.filter((u) => u.role === "donor");
  const ngos = users.filter((u) => u.role === "ngo");
  const claimed = foods.filter((f) => f.claimed);
  const expired = foods.filter((f) => isFoodExpired(f));

  document.getElementById("statsRow").innerHTML = [
    ["🏢", donors.length, "Donors"],
    ["💚", ngos.length, "NGOs"],
    ["🍲", foods.length, "Listings"],
    ["✅", claimed.length, "Claimed"],
    ["⏰", expired.length, "Expired"],
  ].map(([icon, num, label]) => `
    <div class="col-6 col-md-3">
      <div class="card-fs text-center py-3">
        <div style="font-size:1.5rem;">${icon}</div>
        <div class="fw-bold" style="font-size:1.4rem;">${num}</div>
        <div class="text-muted small">${label}</div>
      </div>
    </div>`).join("");

  const userRow = (u) => `
    <div class="d-flex justify-content-between align-items-center py-2 border-bottom">
      <div>
        <div class="fw-semibold small">${u.name}</div>
        <div class="text-muted small">${u.email}</div>
      </div>
    </div>`;
  document.getElementById("donorsList").innerHTML =
    donors.length ? donors.map(userRow).join("") : `<p class="text-muted small mb-0">No donors registered yet.</p>`;
  document.getElementById("ngosList").innerHTML =
    ngos.length ? ngos.map(userRow).join("") : `<p class="text-muted small mb-0">No NGOs registered yet.</p>`;

  const volunteerDeliveries = foods.filter(
    (f) => f.claimed && f.deliveryMethod === "volunteer" && ADMIN_ACTIONABLE_STATUSES.includes(f.status)
  );
  const pendingSection = document.getElementById("pendingAssignments");
  if (pendingSection) {
    pendingSection.innerHTML = volunteerDeliveries.length
      ? volunteerDeliveries.map((f) => volunteerDeliveryCardHtml(f)).join("")
      : `<p class="text-muted small mb-0">No volunteer deliveries need attention right now.</p>`;
  }

  const cleanupBar = document.getElementById("expiredCleanupBar");
  if (cleanupBar) {
    const expiredCount = expired.filter((f) => !f.claimed).length;
    if (expiredCount >= 10) {
      cleanupBar.innerHTML = `
        <button type="button" class="btn-fs-primary" style="background:#c0392b;padding:6px 16px;font-size:0.85rem;" onclick="adminClearExpired()">
          🗑️ Clear ${expiredCount} Expired Listings
        </button>`;
    } else if (expiredCount > 0) {
      cleanupBar.innerHTML = `
        <button type="button" class="btn-fs-outline" style="padding:6px 16px;font-size:0.85rem;" onclick="adminClearExpired()">
          Clear ${expiredCount} expired
        </button>`;
    } else {
      cleanupBar.innerHTML = "";
    }
  }

  const statusLabel = (f) => {
    if (isFoodExpired(f)) return `<span class="badge-pill" style="background:#fdecec;color:#c0392b;">⏰ Expired</span>`;
    if (!f.claimed) return `<span class="badge-pill">Available</span>`;
    const steps = f.deliveryMethod === "volunteer" ? VOLUNTEER_STEPS : PICKUP_STEPS;
    const step = steps.find((s) => s.key === f.status) || steps[0];
    return `<span class="badge-pill">${step.icon} ${step.label}</span>`;
  };
  const actionCell = (f) => {
    if (f.claimed) return "—"; // claimed items follow the delivery flow, no manual expiry
    if (isFoodExpired(f)) {
      return `<button type="button" class="btn-fs-outline" style="padding:4px 10px;font-size:0.75rem;" onclick="adminUnmarkExpired('${f.id}')">Reactivate (+1h)</button>`;
    }
    return `<button type="button" class="btn-fs-outline" style="padding:4px 10px;font-size:0.75rem;" onclick="adminMarkExpired('${f.id}')">Mark Expired</button>`;
  };
  document.getElementById("listingsBody").innerHTML = foods.length
    ? foods.map((f) => `
        <tr class="small">
          <td>${f.title}</td>
          <td>${f.donorName}</td>
          <td>${f.category}</td>
          <td>${statusLabel(f)}</td>
          <td>${f.claimedBy || "—"}${f.volunteerName ? `<br><span class="text-muted">🙋 ${f.volunteerName} · 📞 ${f.volunteerPhone}</span>` : ""}</td>
          <td>${actionCell(f)}</td>
        </tr>`).join("")
    : `<tr><td colspan="6" class="text-muted small">No listings posted yet — try Donate Food.</td></tr>`;
}

document.addEventListener("DOMContentLoaded", () => {
  seedDemoAdmin();
  initRoleCards();
  initFilterPills();
  loadFoodListings();
  loadLiveNow();
  updateNavAuth();

  // Keep Find Food listings live — re-checks each item's donor-set safe
  // window every minute, so a listing auto-flips to "Expired" the moment
  // its timer runs out, without needing a page refresh.
  if (document.getElementById("foodGrid")) {
    setInterval(loadFoodListings, 60000);
  }

  const loginForm = document.getElementById("loginForm");
  if (loginForm) loginForm.addEventListener("submit", handleLogin);

  const registerForm = document.getElementById("registerForm");
  if (registerForm) registerForm.addEventListener("submit", handleRegister);

  const donateForm = document.getElementById("donateForm");
  if (donateForm) donateForm.addEventListener("submit", handleDonateSubmit);
});
