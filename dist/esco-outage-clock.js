// Standalone dashboard resource for ESCO Outages.
const TYPE = "esco-outage-clock";
const CARD_VERSION = "1.6.0";
const DIALS = {
  citizen: "esco-clock-face.png",
  rolex: "esco-clock-rolex.png",
  omega: "esco-clock-omega.png",
};
const labels = {
  start_entity: "Найближче відключення",
  current_start_entity: "Початок поточного відключення",
  current_duration_entity: "Тривалість поточного відключення",
  duration_entity: "Тривалість найближчого відключення",
};
const QUEUES = Array.from({ length: 6 }, (_, i) => [`${i + 1}.1`, `${i + 1}.2`]).flat();
const SENSOR_FIELDS = {
  start_entity: "next_outage_time", duration_entity: "next_outage_minutes",
  current_start_entity: "current_outage_time", current_duration_entity: "current_outage_minutes",
};
const clock = new Intl.DateTimeFormat("uk-UA", {
  timeZone: "Europe/Kyiv", hourCycle: "h23", hour: "2-digit", minute: "2-digit",
});

function minuteOfDay(date) {
  const [hour, minute] = clock.format(date).split(":").map(Number);
  return hour * 60 + minute;
}

function point(minute, radius) {
  const angle = minute * Math.PI / 360;
  return [120 + radius * Math.sin(angle), 120 - radius * Math.cos(angle)];
}

function sector(start, duration) {
  // Two arcs also describe a complete 12-hour circle.
  const points = [start, start + duration / 2, start + duration].map(m => point(m, 85).join(" "));
  return `M120 120 L${points[0]} A85 85 0 0 1 ${points[1]} A85 85 0 0 1 ${points[2]} Z`;
}

function visibleSector(start, duration, current, limitTo12Hours) {
  if (limitTo12Hours && (start >= current + 720 || start + duration <= current)) return "";
  return sector(start % 720, Math.min(duration, 720));
}

function overlapsOnDial(first, second) {
  const split = ([start, length]) => {
    if (length >= 720) return [[0, 720]];
    const begin = start % 720;
    const end = begin + length;
    return end <= 720 ? [[begin, end]] : [[begin, 720], [0, end - 720]];
  };
  return split(first).some(([a, b]) => split(second).some(([c, d]) => a < d && c < b));
}

function futureSectorCoversNow(begin, duration, now) {
  if (begin <= now) return false;
  const elapsed = (minuteOfDay(now) - minuteOfDay(begin) + 720) % 720;
  return elapsed < Math.min(duration, 720);
}

function sectorLabels(start, duration) {
  let markup = "";
  const end = start + duration;
  for (let first = start; first < end;) {
    const boundary = (Math.floor(first / 720) + 1) * 720;
    const last = Math.min(end, boundary);
    const [x, y] = point((first + last) / 2, 16);
    const period = Math.floor(first / 720) % 2 === 0 ? "AM" : "PM";
    markup += `<text x="${x}" y="${y}">${period}</text>`;
    first = last;
  }
  return markup;
}

function durationMinutes(entity) {
  const factor = { min: 1, h: 60, s: 1 / 60, d: 1440 }[entity?.attributes.unit_of_measurement ?? entity?.attributes.duration_unit];
  return Number(entity?.state) * factor;
}

class EscoOutageClock extends HTMLElement {
  static getStubConfig() { return {}; }
  static getConfigElement() { return document.createElement("esco-outage-clock-editor"); }
  static getConfigForm() {
    return {
      schema: [
      { name: "line", selector: { select: { mode: "dropdown", options: [
        { value: "manual", label: "Вибрати сенсори вручну" },
        ...QUEUES.map(value => ({ value, label: `Черга ${value}` })),
      ] } } },
      { name: "title_mode", selector: { select: { mode: "dropdown", options: [
        { value: "next", label: "Найближче відключення" },
        { value: "line", label: "Черга н.н" },
      ] } } },
      { name: "dial", selector: { select: { mode: "dropdown", options: [
        { value: "citizen", label: "Citizen W770 · синій" },
        { value: "rolex", label: "Rolex Submariner · чорний" },
        { value: "omega", label: "Omega Seamaster · хвилі" },
      ] } } },
      ...Object.keys(labels).map(name => ({
        name, selector: { entity: { filter: [{
          integration: "esco_outages", domain: "sensor",
          ...(name.startsWith("current_") ? {} : {
            device_class: name === "start_entity" ? "timestamp" : "duration",
          }),
        }] } },
      })),
      { name: "show_12_hours", selector: { boolean: {} } },
      { name: "show_sector_ampm", default: true, selector: { boolean: {} } },
      { name: "show_last_poll", selector: { boolean: {} } },
      { name: "show_schedule_updated", selector: { boolean: {} } },
      { name: "clear_past_periods", selector: { boolean: {} } },
      { name: "show_real_outage", selector: { boolean: {} } },
      { name: "power_entity", visible: { field: "show_real_outage", value: true },
        selector: { entity: { filter: [{ domain: ["binary_sensor", "switch", "input_boolean", "light", "sensor"] }] } } },
      { name: "invert_power", visible: { field: "show_real_outage", value: true }, selector: { boolean: {} } },
      ],
      computeLabel: field => labels[field.name] ?? {
        line: "Черга — автоматичний вибір сенсорів",
        title_mode: "Заголовок",
        dial: "Циферблат",
        show_12_hours: "Відображати відключення на 12 годин",
        show_sector_ampm: "Відображати AM/PM у секторі",
        show_last_poll: "Час останнього опитування",
        show_schedule_updated: "Час зміни графіка",
        clear_past_periods: "Очищати минулі періоди",
        show_real_outage: "Відображати реальне відключення",
        power_entity: "Датчик наявності електроенергії",
        invert_power: "Інвертувати стан датчика (on означає відключення)",
      }[field.name],
    };
  }

  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
      ha-card{position:relative;display:block;padding:28px 20px 20px;text-align:center;color:var(--primary-text-color)}
      .version{position:absolute;left:10px;top:7px;font-size:9px;line-height:1.2;color:var(--secondary-text-color);opacity:.65;pointer-events:none}
      header{display:flex;align-items:center;justify-content:center;position:relative;min-height:32px;padding:0 38px}
      h2{font-size:18px;font-weight:500;margin:0}
      .bulb{position:absolute;right:0;top:0;border:0;background:transparent;padding:4px;color:#69717b;line-height:0;cursor:pointer}
      .bulb[hidden]{display:none}
      .bulb ha-icon{--mdc-icon-size:26px}
      .bulb.on{color:#ffc533;filter:drop-shadow(0 0 4px #ffbd21) drop-shadow(0 0 9px #ffcc5688)}
      .bulb.unknown{color:var(--secondary-text-color,#8b949e);opacity:.65}
      .bulb:focus-visible{outline:2px solid var(--primary-color);border-radius:6px}
      svg{display:block;width:min(100%,300px);margin:8px auto;color:var(--primary-text-color)}
      .current-sector{fill:#ef5350;fill-opacity:.6;stroke:#ff8a80;stroke-width:.8}
      .sector{fill:#ffad45;fill-opacity:.53;stroke:#ffc46e;stroke-width:.8}
      .sector-labels{pointer-events:none}
      .sector-labels text{font:bold 7px sans-serif;fill:#fff;text-anchor:middle;dominant-baseline:central;paint-order:stroke;stroke:#151b24;stroke-width:2;stroke-linejoin:round}
      .hand,.minute{filter:drop-shadow(0 1px 1px #070d19)}
      strong{font-size:22px;font-variant-numeric:tabular-nums}
      strong:empty{display:none}
      small{display:block;margin-top:5px;color:var(--secondary-text-color)}
      small:empty{display:none}
      footer{display:flex;justify-content:space-between;gap:12px;margin-top:16px;font-size:11px;color:var(--secondary-text-color);text-align:left}
      footer span{flex:1;min-width:0;overflow-wrap:anywhere}
      footer span:last-child{text-align:right}
      footer[hidden]{display:none}
      footer span[hidden]{display:block;visibility:hidden}
    </style><ha-card><span class="version">v${CARD_VERSION}</span><header><h2>Найближче відключення</h2><button class="bulb" hidden><ha-icon icon="mdi:lightbulb-outline"></ha-icon></button></header><svg viewBox="0 0 240 240" aria-hidden="true">
      <defs>
        <linearGradient id="steel" x2=".7" y2="1"><stop stop-color="#edf4fa"/><stop offset=".24" stop-color="#798794"/><stop offset=".48" stop-color="#354452"/><stop offset=".54" stop-color="#d4dce4"/><stop offset="1" stop-color="#526371"/></linearGradient>
        <linearGradient id="blade">
          <stop stop-color="#171f2a"/><stop offset=".09" stop-color="#dde3e5"/>
          <stop offset=".35" stop-color="#fffaf0"/><stop offset=".49" stop-color="#bec9cd"/>
          <stop offset=".51" stop-color="#58636d"/><stop offset=".85" stop-color="#394651"/>
          <stop offset="1" stop-color="#d7dad7"/>
        </linearGradient>
        <linearGradient id="inlay"><stop stop-color="#a5ac9f"/><stop offset=".25" stop-color="#e7e5c9"/><stop offset=".8" stop-color="#f3f0db"/><stop offset="1" stop-color="#b4b8ab"/></linearGradient>
      </defs>
      <image class="face" width="240" height="240"/>
      <path class="sector"/><path class="current-sector"/><g class="sector-labels"></g>
      <g transform="translate(120 163)">
        <circle r="18" fill="#0e1925" stroke="#778493"/><circle r="15.5" fill="none" stroke="#334958" stroke-dasharray="1 2"/>
        <text class="period" y="3" text-anchor="middle" font-size="9" font-family="sans-serif" fill="#b6cadc"></text>
      </g>
      <g class="hand"><path d="M116.9 128L115.4 72 120 57 124.6 72 123.1 128Z" fill="url(#blade)" stroke="#253039" stroke-width=".6"/><path d="M117.9 74l2.1-8 2.1 8-.7 31h-2.8Z" fill="url(#inlay)"/></g>
      <g class="minute"><path d="M117.8 131l-.8-92 3-15 3 15-.8 92Z" fill="url(#blade)" stroke="#26313a" stroke-width=".5"/><path d="M118.7 43l1.3-8 1.3 8-.45 59h-1.7Z" fill="url(#inlay)"/></g>
      <circle cx="120" cy="120" r="4.6" fill="url(#steel)" stroke="#192025" stroke-width=".7"/><circle cx="120" cy="120" r="2.1" fill="url(#blade)"/>
    </svg><strong></strong><small></small><footer><span class="last-poll" hidden></span><span class="schedule-updated" hidden></span></footer></ha-card>`;
    root.querySelector(".face").setAttribute("href", new URL("./esco-clock-face.png", import.meta.url).href);
    this.parts = Object.fromEntries([".sector-labels", ".last-poll", ".schedule-updated", ".bulb", ".sector", ".current-sector", ".hand", ".minute", ".period", "strong", "small"].map(key => [key, root.querySelector(key)]));
    this.parts[".bulb"].addEventListener("click", () => {
      if (!this.config?.power_entity) return;
      this.dispatchEvent(new CustomEvent("hass-more-info", {
        bubbles: true, composed: true, detail: { entityId: this.config.power_entity },
      }));
    });
  }

  setConfig(config) {
    if (config.line !== undefined && config.line !== "manual" && !QUEUES.includes(config.line)) {
      throw new Error("Виберіть чергу від 1.1 до 6.2");
    }
    if (config.title_mode !== undefined && !["next", "line"].includes(config.title_mode)) {
      throw new Error("Виберіть заголовок картки");
    }
    if (config.dial !== undefined && !Object.hasOwn(DIALS, config.dial)) {
      throw new Error("Виберіть циферблат Citizen, Rolex або Omega");
    }
    for (const key of Object.keys(labels)) {
      if (config[key] && !/^sensor\.[a-z0-9_]+$/.test(config[key])) throw new Error(labels[key]);
    }
    this.config = config;
    this.shadowRoot.querySelector(".face").setAttribute("href", new URL(`./${DIALS[config.dial ?? "citizen"]}`, import.meta.url).href);
    this.render();
  }
  set hass(value) {
    const previous = this._hass;
    this._hass = value;
    if (QUEUES.includes(this.config?.line) || !previous || [...Object.keys(labels), "power_entity"].some(k => previous.states[this.config?.[k]] !== value.states[this.config?.[k]])) this.render();
  }
  connectedCallback() {
    const tick = () => {
      this.render();
      this.timer = setTimeout(tick, 60000 - Date.now() % 60000);
    };
    tick();
  }
  disconnectedCallback() { clearTimeout(this.timer); }
  getCardSize() { return 7; }

  _entityId(key) {
    return QUEUES.includes(this.config?.line) ? this.autoEntities?.[key] : this.config?.[key];
  }

  render() {
    const now = new Date();
    const current = minuteOfDay(now);
    const base = current < 720 ? 0 : 720;
    this.parts[".period"].textContent = base ? "PM" : "AM";
    this.parts[".minute"].setAttribute("transform", `rotate(${(current % 60) * 6} 120 120)`);
    this.parts[".hand"].setAttribute("transform", `rotate(${(current - base) / 2} 120 120)`);
    const states = this._hass?.states ?? {};
    this.autoEntities = {};
    if (QUEUES.includes(this.config?.line)) {
      for (const [id, entity] of Object.entries(states)) {
        if (!id.startsWith("sensor.") || entity.attributes?.line !== this.config.line) continue;
        for (const [key, field] of Object.entries(SENSOR_FIELDS)) {
          if (entity.attributes.esco_field === field) this.autoEntities[key] = id;
        }
      }
    }
    const bulb = this.parts[".bulb"];
    bulb.hidden = this.config?.show_real_outage !== true;
    const power = states[this.config?.power_entity]?.state;
    const knownPower = power === "on" || power === "off";
    const powerOn = knownPower && ((power === "on") !== (this.config?.invert_power === true));
    bulb.className = `bulb ${knownPower ? (powerOn ? "on" : "off") : "unknown"}`;
    const powerLabel = !this.config?.power_entity ? "Виберіть датчик електроенергії"
      : !knownPower ? "Стан електроенергії невідомий"
      : powerOn ? "Електроенергія є" : "Електроенергії немає";
    bulb.title = powerLabel;
    bulb.setAttribute("aria-label", powerLabel);
    bulb.querySelector("ha-icon").setAttribute("icon", !knownPower ? "mdi:lightbulb-question-outline" : powerOn ? "mdi:lightbulb-on" : "mdi:lightbulb-outline");
    const start = states[this._entityId("start_entity")];
    this.shadowRoot.querySelector("h2").textContent = this.config?.title_mode === "line"
      ? `Черга ${start?.attributes?.line ?? "—"}`
      : "Найближче відключення";
    const duration = states[this._entityId("duration_entity")];
    for (const [selector, option, attribute, label] of [
      [".last-poll", "show_last_poll", "last_poll", "Опитування"],
      [".schedule-updated", "show_schedule_updated", "schedule_updated", "Зміна графіка"],
    ]) {
      const element = this.parts[selector];
      element.hidden = this.config?.[option] !== true
        || (attribute === "schedule_updated" && start?.attributes?.schedule_status === "missing");
      const date = new Date(start?.attributes?.[attribute] ?? "");
      const stamp = Number.isFinite(date.getTime())
        ? new Intl.DateTimeFormat("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(date)
        : "—";
      element.textContent = `${label}: ${stamp}`;
    }
    this.shadowRoot.querySelector("footer").hidden = this.parts[".last-poll"].hidden && this.parts[".schedule-updated"].hidden;
    const from = new Date(start?.state);
    const minutes = durationMinutes(duration);
    let caption = "";
    let value;
    let path = "";
    let annotations = "";
    if (!this._entityId("start_entity") || !this._entityId("duration_entity")) {
      value = QUEUES.includes(this.config?.line) ? "Сенсори цієї черги не знайдено — додайте її в ESCO Outages" : "Виберіть два сенсори ESCO";
    } else if (!start || !duration || [start.state, duration.state].includes("unavailable")) {
      value = "Сенсори недоступні";
    } else if (start.state === "unknown" && duration.state === "unknown") {
      value = start.attributes?.schedule_status === "off"
        ? "Наступних відключень на сьогодні не заплановано"
        : "Немає даних про наступне відключення";
    } else if (!Number.isFinite(from.getTime()) || !(minutes > 0 && minutes <= 1440)) {
      value = "Перевірте дані сенсорів";
    } else if (from <= now) {
      value = "";
    } else {
      const first = minuteOfDay(from);
      const end = (first + Math.round(minutes)) % 1440;
      const endLabel = [Math.floor(end / 60), end % 60].map(n => String(n).padStart(2, "0")).join(":");
      value = `${clock.format(from)} – ${endLabel}`;
      caption = `${Math.round(minutes)} хв`;
      path = futureSectorCoversNow(from, minutes, now) ? ""
        : visibleSector(first, minutes, current, this.config?.show_12_hours === true);
      if (path) annotations += sectorLabels(first, minutes);
    }
    // The previous next-outage sensors can still describe an active interval
    // until the integration's next poll.
    const activeStart = states[this._entityId("current_start_entity")];
    const activeDuration = states[this._entityId("current_duration_entity")];
    const candidates = [
      [new Date(activeStart?.state), durationMinutes(activeDuration)],
      [from, minutes],
    ];
    let currentPath = "";
    for (const [begin, length] of candidates) {
      const end = new Date(begin.getTime() + length * 60000);
      if (Number.isFinite(begin.getTime()) && length > 0 && length <= 1440 && begin <= now && now < end) {
        currentPath = visibleSector(minuteOfDay(begin), length, current, this.config?.show_12_hours === true);
        if (currentPath) annotations += sectorLabels(minuteOfDay(begin), length);
        caption += `${caption ? " · " : ""}Зараз ${clock.format(begin)}–${clock.format(end)}`;
        break;
      }
    }
    if (Array.isArray(start?.attributes?.outages)) {
      path = "";
      currentPath = "";
      annotations = "";
      const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" });
      const activeIntervals = start.attributes.outages.filter(outage => {
        const begin = new Date(outage.start).getTime();
        return Number.isFinite(begin) && Number.isFinite(outage.duration_minutes)
          && begin <= now.getTime() && now.getTime() < begin + outage.duration_minutes * 60000;
      }).map(outage => [minuteOfDay(new Date(outage.start)), outage.duration_minutes]);
      for (const outage of start.attributes.outages) {
        const begin = new Date(outage.start);
        const length = outage.duration_minutes;
        if (!Number.isFinite(begin.getTime()) || !Number.isFinite(length) || length <= 0 || length > 1440) continue;
        const end = new Date(begin.getTime() + length * 60000);
        if (this.config?.show_12_hours === true) {
          if (end <= now || begin.getTime() >= now.getTime() + 12 * 60 * 60000) continue;
        } else if (dayFormat.format(begin) !== dayFormat.format(now)) continue;
        if (this.config?.clear_past_periods === true && end <= now) continue;
        const active = begin <= now && now < end;
        if (futureSectorCoversNow(begin, length, now)) continue;
        if (!active && activeIntervals.some(interval => overlapsOnDial([minuteOfDay(begin), length], interval))) continue;
        const fragment = visibleSector(minuteOfDay(begin), length, current, false);
        if (fragment) annotations += sectorLabels(minuteOfDay(begin), length);
        if (active) currentPath += fragment;
        else path += fragment;
      }
    }
    if (!currentPath) {
      let status = "";
      if (!this._entityId("current_start_entity") || !this._entityId("current_duration_entity")) {
        status = "Виберіть сенсори поточного відключення в налаштуваннях картки";
      } else if (!activeStart || !activeDuration || [activeStart.state, activeDuration.state].includes("unavailable")) {
        status = "Сенсори поточного відключення недоступні";
      } else if (activeStart.state === "off" || (activeStart.state === "unknown" && activeDuration.state === "unknown")) {
        status = "";
      } else {
        const nextUpdate = new Date(activeDuration?.attributes?.next_update ?? start?.attributes?.next_update);
        const remaining = Math.ceil((nextUpdate.getTime() - now.getTime()) / 60000);
        status = Number.isFinite(remaining) && remaining > 0
          ? `До оновлення даних залишилось ${remaining} хв`
          : "Очікуємо оновлення даних";
      }
      if (status) caption += `${caption ? " · " : ""}${status}`;
    }
    this.parts[".current-sector"].setAttribute("d", currentPath);
    this.parts[".sector"].setAttribute("d", path);
    this.parts[".sector-labels"].innerHTML = this.config?.show_sector_ampm !== false ? annotations : "";
    this.parts.strong.textContent = value;
    this.parts.small.textContent = caption;
  }
}

class EscoOutageClockEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.form = document.createElement("ha-form");
    const definition = EscoOutageClock.getConfigForm();
    this.form.schema = definition.schema;
    this.form.computeLabel = definition.computeLabel;
    this.form.addEventListener("value-changed", event => {
      event.stopPropagation();
      this.config = { ...this.config, ...event.detail.value };
      this._update(true);
    });
    this.shadowRoot.append(this.form);
  }

  setConfig(config) {
    this.config = { ...config };
    this._update();
  }

  set hass(hass) {
    this._hass = hass;
    this.form.hass = hass;
    this._update();
  }

  _update(emit = false) {
    if (!this.config) return;
    if (QUEUES.includes(this.config.line) && this._hass) {
      const selected = {};
      for (const [id, entity] of Object.entries(this._hass.states)) {
        if (!id.startsWith("sensor.") || entity.attributes?.line !== this.config.line) continue;
        for (const [key, field] of Object.entries(SENSOR_FIELDS)) {
          if (entity.attributes.esco_field === field) selected[key] = id;
        }
      }
      for (const key of Object.keys(SENSOR_FIELDS)) {
        if (this.config[key] !== selected[key]) {
          emit = true;
          if (selected[key]) this.config[key] = selected[key];
          else delete this.config[key];
        }
      }
    }
    this.form.data = this.config;
    if (emit) {
      const config = { ...this.config };
      // Defer the notification until HA has attached the editor's listeners.
      queueMicrotask(() => this.dispatchEvent(new CustomEvent("config-changed", {
        bubbles: true, composed: true, detail: { config },
      })));
    }
  }
}

if (!customElements.get("esco-outage-clock-editor")) customElements.define("esco-outage-clock-editor", EscoOutageClockEditor);
if (!customElements.get(TYPE)) customElements.define(TYPE, EscoOutageClock);
window.customCards ??= [];
if (!window.customCards.some(card => card.type === TYPE)) {
  window.customCards.push({ type: TYPE, name: "ESCO · Годинник відключень", description: "Найближче відключення на 12-годинному циферблаті" });
}
