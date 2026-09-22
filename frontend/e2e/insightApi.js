// Thin helpers over the Insight API, used for setup, teardown and cross-checks.
export async function sources(request) {
  const response = await request.get('/api/mediasrc')
  if (!response.ok()) throw new Error(`GET /api/mediasrc failed: ${response.status()}`)
  return response.json()
}

export async function sourceByIndex(request, index) {
  return (await sources(request)).find((s) => s.index === index)
}

// Stops and clears every slot that points into the test folder, leaving other slots untouched.
export async function releaseTestSources(request, folderName) {
  for (const src of await sources(request)) {
    if (!(src.file || '').startsWith(`${folderName}/`)) continue
    if (src.state === 'playing') await request.post('/api/mediasrc/stop', { data: { index: src.index } })
    await request.post('/api/mediasrc/assign', { data: { index: src.index, file: '', transport: src.transport || 'rtsp' } })
  }
}

// Removes the test folder through the API so assignments and renditions are cleaned up too.
export async function deleteViaApi(request, relPath) {
  const response = await request.post('/api/delete-media', { data: { path: relPath } })
  if (!response.ok()) throw new Error(`POST /api/delete-media failed: ${response.status()}`)
}

export async function openTab(page, route) {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('neat-insight:onboarding-seen', '1')
    } catch {}
  })
  await page.goto(route)
}
