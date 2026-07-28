;(function () {
  let bridgePortPromise = null
  const bridgeEventHandlers = new Map()
  const LOG_PREFIX = '[wormbits extension]'

  function createWormbitsClient() {
    const extensionId = 'wormbits'
    const baseUrl = `/api/v1/ext/${extensionId}`

    return {
      context() {
        return bridgeRequest({action: 'context'})
      },

      notify(message, level = 'info') {
        return bridgeRequest({
          action: 'ui.notify',
          level,
          message: errorMessage(message)
        })
      },

      sessionGet(key) {
        return bridgeRequest({action: 'storage.session.get', key}).then(
          response => response?.value ?? null
        )
      },

      sessionSet(key, value) {
        return bridgeRequest({
          action: 'storage.session.set',
          key,
          value
        })
      },

      createRoom(payload) {
        return request(`${baseUrl}/rooms`, {method: 'POST', body: payload})
      },

      getRoom(roomId, playerToken = '') {
        const query = playerToken
          ? `?${new URLSearchParams({playerToken}).toString()}`
          : ''
        return request(
          `${baseUrl}/rooms/${encodeURIComponent(roomId)}${query}`
        )
      },

      joinRoom(roomId, payload) {
        return request(`${baseUrl}/rooms/${encodeURIComponent(roomId)}/join`, {
          method: 'POST',
          body: payload
        })
      },

      spectateRoom(roomId, payload) {
        return request(
          `${baseUrl}/rooms/${encodeURIComponent(roomId)}/spectate`,
          {method: 'POST', body: payload}
        )
      },

      setReady(roomId, payload) {
        return request(`${baseUrl}/rooms/${encodeURIComponent(roomId)}/ready`, {
          method: 'POST',
          body: payload
        })
      },

      startMatch(roomId, payload) {
        return request(`${baseUrl}/rooms/${encodeURIComponent(roomId)}/start`, {
          method: 'POST',
          body: payload
        })
      },

      submitAction(roomId, payload) {
        return request(
          `${baseUrl}/rooms/${encodeURIComponent(roomId)}/actions`,
          {method: 'POST', body: payload}
        )
      },

      heartbeat(roomId, payload) {
        return request(
          `${baseUrl}/rooms/${encodeURIComponent(roomId)}/heartbeat`,
          {method: 'POST', body: payload}
        )
      },

      forfeit(roomId, payload) {
        return request(
          `${baseUrl}/rooms/${encodeURIComponent(roomId)}/forfeit`,
          {method: 'POST', body: payload}
        )
      },

      subscribeWebsocket(itemId, callback) {
        return subscribeWebsocket(itemId, callback)
      }
    }
  }

  function request(path, {method = 'GET', body = null} = {}) {
    const safeBody = plainData(body)
    return bridgeRequest({
      action: 'api',
      method,
      path,
      body: safeBody
    })
      .then(unwrapRuntimeResponse)
      .catch(error => {
        logFailure('API request failed.', {method, path, error})
        throw error
      })
  }

  function bridgeRequest(message) {
    if (window.parent === window) {
      return Promise.reject(
        new Error('LNbits extension bridge is not available.')
      )
    }
    return getBridgePort().then(port => bridgePortRequest(port, message))
  }

  function getBridgePort() {
    if (!bridgePortPromise) bridgePortPromise = connectBridge()
    return bridgePortPromise
  }

  function connectBridge() {
    const id = requestId()
    const channel = new MessageChannel()
    const parentOrigin = new URL(window.location.href).origin
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        channel.port1.removeEventListener('message', onMessage)
        channel.port1.close()
        reject(new Error('LNbits extension bridge timed out.'))
      }, 30000)

      function onMessage(event) {
        const response = event.data
        if (
          event.currentTarget !== channel.port1 ||
          response?.type !== 'lnbits-extension:connected' ||
          response.id !== id
        ) {
          return
        }
        window.clearTimeout(timeout)
        channel.port1.removeEventListener('message', onMessage)
        attachBridgeEvents(channel.port1)
        resolve(channel.port1)
      }

      channel.port1.addEventListener('message', onMessage)
      channel.port1.start()
      window.parent.postMessage(
        {type: 'lnbits-extension:connect', id},
        parentOrigin,
        [channel.port2]
      )
    })
  }

  function bridgePortRequest(port, message) {
    const id = requestId()
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        port.removeEventListener('message', onMessage)
        reject(new Error('LNbits extension bridge timed out.'))
      }, 30000)

      function onMessage(event) {
        const response = event.data
        if (
          event.currentTarget !== port ||
          response?.type !== 'lnbits-extension:response' ||
          response.id !== id
        ) {
          return
        }
        window.clearTimeout(timeout)
        port.removeEventListener('message', onMessage)
        if (response.ok === false) {
          reject(new Error(response.error || 'Extension call failed.'))
          return
        }
        resolve(response.data)
      }

      port.addEventListener('message', onMessage)
      port.postMessage({
        type: 'lnbits-extension:request',
        id,
        ...message
      })
    })
  }

  function attachBridgeEvents(port) {
    if (port.__wormbitsEventsAttached) return
    port.__wormbitsEventsAttached = true
    port.addEventListener('message', event => {
      if (event.currentTarget !== port) return
      const message = event.data
      if (message?.type !== 'lnbits-extension:event') return
      bridgeEventHandlers.get(message.subscriptionId)?.(message)
    })
  }

  function subscribeWebsocket(itemId, callback) {
    if (typeof callback !== 'function') {
      return Promise.reject(
        new Error('WebSocket subscription needs a callback.')
      )
    }
    const subscriptionId = requestId()
    bridgeEventHandlers.set(subscriptionId, callback)
    return bridgeRequest({
      action: 'websocket.subscribe',
      subscriptionId,
      itemId
    })
      .then(() => {
        let active = true
        return {
          get active() {
            return active
          },
          unsubscribe() {
            if (!active) return
            active = false
            bridgeEventHandlers.delete(subscriptionId)
            bridgeRequest({
              action: 'websocket.unsubscribe',
              subscriptionId
            }).catch(error => {
              logFailure('WebSocket unsubscribe failed.', {error})
            })
          }
        }
      })
      .catch(error => {
        bridgeEventHandlers.delete(subscriptionId)
        throw error
      })
  }

  function unwrapRuntimeResponse(value) {
    if (typeof value === 'string') value = JSON.parse(value)
    if (value?.ok === false) {
      throw new Error(value.error || 'Extension call failed.')
    }
    if (value?.ok === true) return value.data || {}
    return value || {}
  }

  function plainData(value) {
    if (value === undefined || value === null) return null
    return JSON.parse(JSON.stringify(value))
  }

  function requestId() {
    return (
      window.crypto?.randomUUID?.() ||
      `wormbits_${Date.now()}_${Math.random().toString(36).slice(2)}`
    )
  }

  function errorMessage(value) {
    return String(value || 'Something went wrong.').slice(0, 500)
  }

  function logFailure(message, details = {}) {
    window.console?.error?.(LOG_PREFIX, message, details)
  }

  window.createWormbitsClient = createWormbitsClient
})()
