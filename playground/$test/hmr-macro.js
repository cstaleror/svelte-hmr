import { assert } from 'vitest'
import { initHmrTest } from './hmr-context.js'
import { identity, normalizeHtml } from './util.js'

/** @typedef {import('playwright-chromium').Page} Page */

/**
 * @typedef {Record<
 *   string,
 *   string | Record<string, string> | ((code: string) => string)
 * >} TestHmrStepEdit
 *
 * @typedef {string | Record<string, string>} TestHmrStepExpect
 *
 * @typedef {| {
 *       name?: string
 *       expect?: TestHmrStepExpect
 *       edit?: TestHmrStepEdit
 *     }
 *   | ((page: Page) => Promise<void> | void)} TestHmrStepStepsItem
 *
 * @typedef {TestHmrStepStepsItem | TestHmrStepStepsItem[]} TestHmrStepStepsItems
 *
 * @typedef {TestHmrStepStepsItems | TestHmrStepStepsItems[]} TestHmrStepSteps
 *
 * @typedef {{
 *   name: string
 *   edit?: TestHmrStepEdit
 *   expect?: TestHmrStepExpect
 *   steps?: TestHmrStepSteps
 * }} TestHmrStep
 *
 * @typedef {Record<
 *   string,
 *   string | ((placeholders: Record<string, string>) => string)
 * >} FilesOption
 *
 * @typedef {Omit<TestHmrStep, 'name'> & {
 *   name?: string
 *   cd?: string
 *   exposeFunction?: Record<string, function>
 *   files?: FilesOption
 * }} TestHmrInitStep
 */

/**
 * @typedef {[TestHmrInitStep, ...TestHmrStep[]]} TestHmrArg
 * @param {TestHmrArg | ((ctx: import('vitest').TestContext) => TestHmrArg)} _steps
 */
export const hmr = (_steps) => {
  /** @param {import('vitest').TestContext} ctx */
  return async (ctx) => {
    if (typeof _steps === 'function') {
      return hmr(_steps(ctx))
    }

    const {
      cd = 'src',
      name = 'init',
      exposeFunction,
      files = {},
      ...init
    } = /** @type {TestHmrInitStep} */ (_steps.shift())

    _steps.unshift({ ...init, name })

    const steps = /** @type {TestHmrStep[]} */ (_steps)

    const resolve =
      cd && cd !== '.'
        ? /** @param {string} file */
          (file) => `${cd}/${file}`
        : identity

    const { start, stop } = initHmrTest(ctx)

    try {
      const { page, edit } = await start({
        exposeFunction,
        files: Object.fromEntries(
          Object.entries(files).map(([file, contents]) => [
            resolve(file),
            typeof contents === 'function' ? contents({}) : contents,
          ])
        ),
      })

      for (const step of steps) {
        /** @param {(typeof step)['edit']} editSpec */
        const runEdit = async (editSpec) => {
          await Promise.all(
            Object.entries(editSpec).map(([file, arg]) => {
              const resolveContents = () => {
                if (typeof arg === 'object') {
                  const template = files?.[file]
                  if (template == null) {
                    throw new Error(`Cannot edit missing file: ${file}`)
                  }
                  return /** @type {function} */ (template)(arg)
                } else {
                  return arg
                }
              }
              return edit(resolve(file), resolveContents())
            })
          )
        }

        /**
         * @param {(typeof step)['expect']} expect
         * @param {string} name
         */
        const runExpect = async (expect, name) => {
          const expects =
            typeof expect === 'string'
              ? [['body', expect]]
              : Object.entries(expect)
          for (const [selector, expected] of expects) {
            const el = await page.$(selector)
            if (!el) {
              throw new Error(`Not found in page: ${selector}`)
            }
            assert.equal(
              normalizeHtml(await el.innerHTML()),
              normalizeHtml(expected),
              `${name} > ${selector}`
            )
          }
        }

        if ('edit' in step) {
          await runEdit(step.edit)
        }

        if ('expect' in step) {
          await runExpect(step.expect, step.name)
        }

        if ('steps' in step) {
          /** @param {TestHmrStepSteps} sub */
          const runSubStep = async (sub, i = 0) => {
            if (Array.isArray(sub)) {
              let i = 0
              for (const subsub of sub) {
                await runSubStep(subsub, i++)
              }
            } else if (typeof sub === 'function') {
              await sub(page)
            } else {
              const unknownOptions = new Set(Object.keys(sub))
              if ('name' in sub) {
                unknownOptions.delete('name')
                // TODO
              }
              if ('edit' in sub) {
                unknownOptions.delete('edit')
                await runEdit(sub.edit)
              }
              if ('expect' in sub) {
                unknownOptions.delete('expect')
                await runExpect(
                  sub.expect,
                  `${step.name} > ${sub.name || `steps[${i}]`}`
                )
              }
              if (unknownOptions.size > 0) {
                throw new Error(
                  `Unkown options in step ${step.name}: ${[
                    // @ts-ignore
                    ...unknownOptions,
                  ].join(', ')}`
                )
              }
            }
          }

          await runSubStep(step.steps)
        }
      }
    } finally {
      await stop()
    }
  }
}
