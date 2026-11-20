// The product's stage is the agent's technical `stage` setting, not a UI default: the seed sets Watch, so a signed-in
// Admin sees Watch on Settings > Stage and plan (it showed Act when the stage came from the UI store).
import { expect, test } from '../support/test-build/index.js'
import { open, signInAs } from '../support/clients/real.js'

test('Stage and plan shows the seeded stage, Watch', async ({ page, context }) => {
  await signInAs(context, 'admin')
  await open(page, 'admin', '#/settings/team-plan')
  await expect(page.getByRole('heading', { level: 1, name: 'Stage and plan', exact: true })).toBeVisible()
  await expect(page.getByRole('main').getByText('Watch: your Inhouse agent reads every tool and changes nothing.')).toBeVisible()
})
