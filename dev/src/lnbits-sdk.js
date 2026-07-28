import {
  createInvoicePublic,
  listUserWallets,
  log,
  now,
  payLnurl,
  randomId,
  storageDelete,
  storageGet,
  storageGetPaginated,
  storageSet,
  websocketPublish
} from 'lnbits:extension/host'

export const storage = {
  get(table, id, fallback = null) {
    const {dataJson} = storageGet({table, id})
    return dataJson ? JSON.parse(dataJson) : fallback
  },

  set(table, data) {
    storageSet({table, dataJson: JSON.stringify(data)})
    return data
  },

  delete(table, id) {
    storageDelete({table, id})
  },

  list(table, options = {}) {
    const response = storageGetPaginated({
      table,
      filtersJson: JSON.stringify(options.filters || {}),
      search: '',
      searchFields: [],
      sortBy: options.sortBy || '',
      descending: options.descending === true,
      limit: options.limit || 100,
      offset: options.offset || 0
    })
    return {
      data: JSON.parse(response.rowsJson || '[]'),
      total: Number(response.total || 0)
    }
  }
}

export const wallet = {
  listUserWallets() {
    return listUserWallets().wallets || []
  },

  createInvoicePublic({
    sourceId,
    amount,
    currency = 'sat',
    memo = '',
    extra = {}
  }) {
    return createInvoicePublic({
      sourceId,
      amount: Number(amount),
      currency,
      memo,
      extra: Object.entries(extra).map(([key, value]) => [
        key,
        String(value)
      ])
    })
  },

  payLnurl({
    walletId,
    lnurl,
    amount,
    currency = 'sat',
    comment = '',
    maxSat = 0,
    description = '',
    extra = {}
  }) {
    return payLnurl({
      walletId,
      lnurl,
      amount: Number(amount),
      currency,
      comment: comment || undefined,
      maxSat: maxSat > 0 ? BigInt(maxSat) : undefined,
      description,
      extra: Object.entries(extra).map(([key, value]) => [
        key,
        String(value)
      ])
    })
  }
}

export const system = {
  id(prefix) {
    return randomId({prefix}).id
  },

  now() {
    const response = now()
    const timestamp =
      response && typeof response === 'object'
        ? response.timestamp ?? response.value
        : response
    const number = Number(timestamp)
    return Number.isFinite(number) && number > 0
      ? Math.trunc(number)
      : Math.floor(Date.now() / 1000)
  },

  log(message, level = 'info') {
    log({level, message})
  }
}

export const websocket = {
  publish(itemId, data) {
    return websocketPublish({
      itemId,
      dataJson: JSON.stringify(data || {})
    }).sent
  }
}
