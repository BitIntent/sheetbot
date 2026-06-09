/**
 * landing 定价区：从 /api/public/plans 刷新价格与配额说明（与后台 subscription_plans 一致）
 */
;(function () {
  var CK = '<div class="pr-ck"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div>'
  var CK_ENT = '<div class="pr-ck" style="background:rgba(129,140,248,.15);color:#818CF8"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div>'

  function fmtYuan(yuan) {
    if (yuan == null) return ''
    return Number.isInteger(yuan) ? String(yuan) : yuan.toFixed(2)
  }

  function applyPlan(card, plan) {
    var tier = card.querySelector('.pr-tier')
    if (tier) tier.textContent = plan.name

    var desc = card.querySelector('.pr-desc')
    if (desc && plan.description) desc.textContent = plan.description

    var priceWrap = card.querySelector('.pr-price')
    if (priceWrap) {
      if (plan.price_label) {
        var amtStyle = plan.variant === 'enterprise'
          ? ' style="font-size:24px;background:linear-gradient(135deg,#818CF8,#A78BFA);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text"'
          : ''
        priceWrap.innerHTML = '<span class="pr-amt"' + amtStyle + '>' + plan.price_label + '</span>'
      } else if (plan.price_monthly_yuan != null) {
        var grad = plan.highlight
          ? ' style="background:linear-gradient(135deg,var(--accent),#6EE7B7);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text"'
          : ''
        priceWrap.innerHTML =
          '<span class="pr-cur">¥</span><span class="pr-amt"' + grad + '>' +
          fmtYuan(plan.price_monthly_yuan) + '</span><span class="pr-per"> /月</span>'
      }
    }

    var yearlyEl = card.querySelector('.pr-yearly-note')
    if (yearlyEl) {
      if (plan.yearly_note) {
        yearlyEl.textContent = plan.yearly_note
        yearlyEl.style.display = ''
      } else {
        yearlyEl.style.display = 'none'
      }
    }

    var badge = card.querySelector('.pr-badge')
    if (badge) badge.style.display = plan.badge ? '' : 'none'
    if (badge && plan.badge) badge.textContent = plan.badge

    var ul = card.querySelector('.pr-feats')
    if (ul && plan.features && plan.features.length) {
      var ent = plan.variant === 'enterprise'
      ul.innerHTML = plan.features.map(function (f) {
        return '<li class="pr-feat' + (f.enabled ? '' : ' dis') + '">' +
          (ent ? CK_ENT : CK) + f.text + '</li>'
      }).join('')
    }

    var btn = card.querySelector('.pr-btn')
    if (btn && plan.cta) btn.textContent = plan.cta
  }

  fetch('/api/public/plans', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('plans fetch failed')) })
    .then(function (data) {
      var byCode = {}
      ;(data.plans || []).forEach(function (p) { byCode[p.code] = p })
      document.querySelectorAll('#pricing [data-plan-code]').forEach(function (card) {
        var plan = byCode[card.getAttribute('data-plan-code')]
        if (!plan) {
          card.style.display = 'none'
          return
        }
        card.style.display = ''
        applyPlan(card, plan)
      })
    })
    .catch(function () { /* 保留静态 HTML 作 SEO/无网兜底 */ })
})()
