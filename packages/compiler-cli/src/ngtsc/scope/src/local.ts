/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {ExternalExpr, SchemaMetadata} from '@angular/compiler';
import ts from 'typescript';

import {ErrorCode, makeDiagnostic, makeRelatedInformation} from '../../diagnostics';
import {AliasingHost, Reexport, Reference, ReferenceEmitter} from '../../imports';
import {DirectiveMeta, MetadataReader, MetadataRegistry, NgModuleMeta, PipeMeta} from '../../metadata';
import {ClassDeclaration, DeclarationNode} from '../../reflection';
import {identifierOfNode, nodeNameForError} from '../../util/src/typescript';

import {ExportScope, RemoteScope, ScopeData} from './api';
import {ComponentScopeReader} from './component_scope';
import {DtsModuleScopeResolver} from './dependency';

export interface LocalNgModuleData {
  declarations: Reference<ClassDeclaration>[];
  imports: Reference<ClassDeclaration>[];
  exports: Reference<ClassDeclaration>[];
}

export interface LocalModuleScope extends ExportScope {
  ngModule: ClassDeclaration;
  compilation: ScopeData;
  reexports: Reexport[]|null;
  schemas: SchemaMetadata[];
}

/**
 * A registry which collects information about NgModules, Directives, Components, and Pipes which
 * are local (declared in the ts.Program being compiled), and can produce `LocalModuleScope`s
 * which summarize the compilation scope of a component.
 *
 * This class implements the logic of NgModule declarations, imports, and exports and can produce,
 * for a given component, the set of directives and pipes which are "visible" in that component's
 * template.
 *
 * The `LocalModuleScopeRegistry` has two "modes" of operation. During analysis, data for each
 * individual NgModule, Directive, Component, and Pipe is added to the registry. No attempt is made
 * to traverse or validate the NgModule graph (imports, exports, etc). After analysis, one of
 * `getScopeOfModule` or `getScopeForComponent` can be called, which traverses the NgModule graph
 * and applies the NgModule logic to generate a `LocalModuleScope`, the full scope for the given
 * module or component.
 *
 * The `LocalModuleScopeRegistry` is also capable of producing `ts.Diagnostic` errors when Angular
 * semantics are violated.
 */
export class LocalModuleScopeRegistry implements MetadataRegistry, ComponentScopeReader {
  /**
   * Tracks whether the registry has been asked to produce scopes for a module or component. Once
   * this is true, the registry cannot accept registrations of new directives/pipes/modules as it
   * would invalidate the cached scope data.
   */
  private sealed = false;

  /**
   * A map of components from the current compilation unit to the NgModule which declared them.
   *
   * As components and directives are not distinguished at the NgModule level, this map may also
   * contain directives. This doesn't cause any problems but isn't useful as there is no concept of
   * a directive's compilation scope.
   */
  private declarationToModule = new Map<ClassDeclaration, DeclarationData>();

  /**
   * This maps from the directive/pipe class to a map of data for each NgModule that declares the
   * directive/pipe. This data is needed to produce an error for the given class.
   */
  private duplicateDeclarations =
      new Map<ClassDeclaration, Map<ClassDeclaration, DeclarationData>>();

  private moduleToRef = new Map<ClassDeclaration, Reference<ClassDeclaration>>();

  /**
   * A cache of calculated `LocalModuleScope`s for each NgModule declared in the current program.

   */
  private cache = new Map<ClassDeclaration, LocalModuleScope|null>();

  /**
   * Tracks the `RemoteScope` for components requiring "remote scoping".
   *
   * Remote scoping is when the set of directives which apply to a given component is set in the
   * NgModule's file instead of directly on the component def (which is sometimes needed to get
   * around cyclic import issues). This is not used in calculation of `LocalModuleScope`s, but is
   * tracked here for convenience.
   */
  private remoteScoping = new Map<ClassDeclaration, RemoteScope>();

  /**
   * Tracks errors accumulated in the processing of scopes for each module declaration.
   */
  private scopeErrors = new Map<ClassDeclaration, ts.Diagnostic[]>();

  /**
   * Tracks which NgModules have directives/pipes that are declared in more than one module.
   */
  private modulesWithStructuralErrors = new Set<ClassDeclaration>();

  constructor(
      private localReader: MetadataReader, private dependencyScopeReader: DtsModuleScopeResolver,
      private refEmitter: ReferenceEmitter, private aliasingHost: AliasingHost|null) {}

  /**
   * Add an NgModule's data to the registry.
   */
  registerNgModuleMetadata(data: NgModuleMeta): void {
    this.assertCollecting();
    const ngModule = data.ref.node;
    this.moduleToRef.set(data.ref.node, data.ref);
    // Iterate over the module's declarations, and add them to declarationToModule. If duplicates
    // are found, they're instead tracked in duplicateDeclarations.
    for (const decl of data.declarations) {
      this.registerDeclarationOfModule(ngModule, decl, data.rawDeclarations);
    }
  }

  registerDirectiveMetadata(directive: DirectiveMeta): void {}

  registerPipeMetadata(pipe: PipeMeta): void {}

  getScopeForComponent(clazz: ClassDeclaration): LocalModuleScope|null {
    const scope = !this.declarationToModule.has(clazz) ?
        null :
        this.getScopeOfModule(this.declarationToModule.get(clazz)!.ngModule);
    return scope;
  }

  /**
   * If `node` is declared in more than one NgModule (duplicate declaration), then get the
   * `DeclarationData` for each offending declaration.
   *
   * Ordinarily a class is only declared in one NgModule, in which case this function returns
   * `null`.
   */
  getDuplicateDeclarations(node: ClassDeclaration): DeclarationData[]|null {
    if (!this.duplicateDeclarations.has(node)) {
      return null;
    }

    return Array.from(this.duplicateDeclarations.get(node)!.values());
  }

  /**
   * Collects registered data for a module and its directives/pipes and convert it into a full
   * `LocalModuleScope`.
   *
   * This method implements the logic of NgModule imports and exports. It returns the
   * `LocalModuleScope` for the given NgModule if one can be produced, `null` if no scope was ever
   * defined, or the string `'error'` if the scope contained errors.
   */
  getScopeOfModule(clazz: ClassDeclaration): LocalModuleScope|null {
    return this.moduleToRef.has(clazz) ?
        this.getScopeOfModuleReference(this.moduleToRef.get(clazz)!) :
        null;
  }

  /**
   * Retrieves any `ts.Diagnostic`s produced during the calculation of the `LocalModuleScope` for
   * the given NgModule, or `null` if no errors were present.
   */
  getDiagnosticsOfModule(clazz: ClassDeclaration): ts.Diagnostic[]|null {
    // Required to ensure the errors are populated for the given class. If it has been processed
    // before, this will be a no-op due to the scope cache.
    this.getScopeOfModule(clazz);

    if (this.scopeErrors.has(clazz)) {
      return this.scopeErrors.get(clazz)!;
    } else {
      return null;
    }
  }

  private registerDeclarationOfModule(
      ngModule: ClassDeclaration, decl: Reference<ClassDeclaration>,
      rawDeclarations: ts.Expression|null): void {
    const declData: DeclarationData = {
      ngModule,
      ref: decl,
      rawDeclarations,
    };

    // First, check for duplicate declarations of the same directive/pipe.
    if (this.duplicateDeclarations.has(decl.node)) {
      // This directive/pipe has already been identified as being duplicated. Add this module to the
      // map of modules for which a duplicate declaration exists.
      this.duplicateDeclarations.get(decl.node)!.set(ngModule, declData);
    } else if (
        this.declarationToModule.has(decl.node) &&
        this.declarationToModule.get(decl.node)!.ngModule !== ngModule) {
      // This directive/pipe is already registered as declared in another module. Mark it as a
      // duplicate instead.
      const duplicateDeclMap = new Map<ClassDeclaration, DeclarationData>();
      const firstDeclData = this.declarationToModule.get(decl.node)!;

      // Mark both modules as having duplicate declarations.
      this.modulesWithStructuralErrors.add(firstDeclData.ngModule);
      this.modulesWithStructuralErrors.add(ngModule);

      // Being detected as a duplicate means there are two NgModules (for now) which declare this
      // directive/pipe. Add both of them to the duplicate tracking map.
      duplicateDeclMap.set(firstDeclData.ngModule, firstDeclData);
      duplicateDeclMap.set(ngModule, declData);
      this.duplicateDeclarations.set(decl.node, duplicateDeclMap);

      // Remove the directive/pipe from `declarationToModule` as it's a duplicate declaration, and
      // therefore not valid.
      this.declarationToModule.delete(decl.node);
    } else {
      // This is the first declaration of this directive/pipe, so map it.
      this.declarationToModule.set(decl.node, declData);
    }
  }

  /**
   * Implementation of `getScopeOfModule` which accepts a reference to a class.
   */
  private getScopeOfModuleReference(ref: Reference<ClassDeclaration>): LocalModuleScope|null {
    if (this.cache.has(ref.node)) {
      return this.cache.get(ref.node)!;
    }

    // Seal the registry to protect the integrity of the `LocalModuleScope` cache.
    this.sealed = true;

    // `ref` should be an NgModule previously added to the registry. If not, a scope for it
    // cannot be produced.
    const ngModule = this.localReader.getNgModuleMetadata(ref);
    if (ngModule === null) {
      this.cache.set(ref.node, null);
      return null;
    }

    // Modules which contributed to the compilation scope of this module.
    const compilationModules = new Set<ClassDeclaration>([ngModule.ref.node]);
    // Modules which contributed to the export scope of this module.
    const exportedModules = new Set<ClassDeclaration>([ngModule.ref.node]);

    // Errors produced during computation of the scope are recorded here. At the end, if this array
    // isn't empty then `undefined` will be cached and returned to indicate this scope is invalid.
    const diagnostics: ts.Diagnostic[] = [];

    // At this point, the goal is to produce two distinct transitive sets:
    // - the directives and pipes which are visible to components declared in the NgModule.
    // - the directives and pipes which are exported to any NgModules which import this one.

    // Directives and pipes in the compilation scope.
    const compilationDirectives = new Map<DeclarationNode, DirectiveMeta>();
    const compilationPipes = new Map<DeclarationNode, PipeMeta>();

    const declared = new Set<DeclarationNode>();

    // Directives and pipes exported to any importing NgModules.
    const exportDirectives = new Map<DeclarationNode, DirectiveMeta>();
    const exportPipes = new Map<DeclarationNode, PipeMeta>();

    // The algorithm is as follows:
    // 1) Add all of the directives/pipes from each NgModule imported into the current one to the
    //    compilation scope.
    // 2) Add directives/pipes declared in the NgModule to the compilation scope. At this point, the
    //    compilation scope is complete.
    // 3) For each entry in the NgModule's exports:
    //    a) Attempt to resolve it as an NgModule with its own exported directives/pipes. If it is
    //       one, add them to the export scope of this NgModule.
    //    b) Otherwise, it should be a class in the compilation scope of this NgModule. If it is,
    //       add it to the export scope.
    //    c) If it's neither an NgModule nor a directive/pipe in the compilation scope, then this
    //       is an error.

    //
    let isPoisoned = false;
    if (this.modulesWithStructuralErrors.has(ngModule.ref.node)) {
      // If the module contains declarations that are duplicates, then it's considered poisoned.
      isPoisoned = true;
    }

    // 1) process imports.
    for (const decl of ngModule.imports) {
      const importScope = this.getExportedScope(decl, diagnostics, ref.node, 'import');
      if (importScope === null) {
        // An import wasn't an NgModule, so record an error.
        diagnostics.push(invalidRef(ref.node, decl, 'import'));
        isPoisoned = true;
        continue;
      } else if (importScope === 'invalid' || importScope.exported.isPoisoned) {
        // An import was an NgModule but contained errors of its own. Record this as an error too,
        // because this scope is always going to be incorrect if one of its imports could not be
        // read.
        diagnostics.push(invalidTransitiveNgModuleRef(ref.node, decl, 'import'));
        isPoisoned = true;

        if (importScope === 'invalid') {
          continue;
        }
      }

      for (const directive of importScope.exported.directives) {
        compilationDirectives.set(directive.ref.node, directive);
      }
      for (const pipe of importScope.exported.pipes) {
        compilationPipes.set(pipe.ref.node, pipe);
      }
      for (const importedModule of importScope.exported.ngModules) {
        compilationModules.add(importedModule);
      }
    }

    // 2) add declarations.
    for (const decl of ngModule.declarations) {
      const directive = this.localReader.getDirectiveMetadata(decl);
      const pipe = this.localReader.getPipeMetadata(decl);
      if (directive !== null) {
        compilationDirectives.set(decl.node, {...directive, ref: decl});
        if (directive.isPoisoned) {
          isPoisoned = true;
        }
      } else if (pipe !== null) {
        compilationPipes.set(decl.node, {...pipe, ref: decl});
      } else {
        const errorNode = decl.getOriginForDiagnostics(ngModule.rawDeclarations!);
        diagnostics.push(makeDiagnostic(
            ErrorCode.NGMODULE_INVALID_DECLARATION, errorNode,
            `The class '${decl.node.name.text}' is listed in the declarations ` +
                `of the NgModule '${
                    ngModule.ref.node.name
                        .text}', but is not a directive, a component, or a pipe. ` +
                `Either remove it from the NgModule's declarations, or add an appropriate Angular decorator.`,
            [makeRelatedInformation(
                decl.node.name, `'${decl.node.name.text}' is declared here.`)]));
        isPoisoned = true;
        continue;
      }

      declared.add(decl.node);
    }

    // 3) process exports.
    // Exports can contain modules, components, or directives. They're processed differently.
    // Modules are straightforward. Directives and pipes from exported modules are added to the
    // export maps. Directives/pipes are different - they might be exports of declared types or
    // imported types.
    for (const decl of ngModule.exports) {
      // Attempt to resolve decl as an NgModule.
      const exportScope = this.getExportedScope(decl, diagnostics, ref.node, 'export');
      if (exportScope === 'invalid' || (exportScope !== null && exportScope.exported.isPoisoned)) {
        // An export was an NgModule but contained errors of its own. Record this as an error too,
        // because this scope is always going to be incorrect if one of its exports could not be
        // read.
        diagnostics.push(invalidTransitiveNgModuleRef(ref.node, decl, 'export'));
        isPoisoned = true;

        if (exportScope === 'invalid') {
          continue;
        }
      } else if (exportScope !== null) {
        // decl is an NgModule.
        for (const directive of exportScope.exported.directives) {
          exportDirectives.set(directive.ref.node, directive);
        }
        for (const pipe of exportScope.exported.pipes) {
          exportPipes.set(pipe.ref.node, pipe);
        }
        for (const exportedModule of exportScope.exported.ngModules) {
          exportedModules.add(exportedModule);
        }
      } else if (compilationDirectives.has(decl.node)) {
        // decl is a directive or component in the compilation scope of this NgModule.
        const directive = compilationDirectives.get(decl.node)!;
        exportDirectives.set(decl.node, directive);
      } else if (compilationPipes.has(decl.node)) {
        // decl is a pipe in the compilation scope of this NgModule.
        const pipe = compilationPipes.get(decl.node)!;
        exportPipes.set(decl.node, pipe);
      } else {
        // decl is an unknown export.
        if (this.localReader.getDirectiveMetadata(decl) !== null ||
            this.localReader.getPipeMetadata(decl) !== null) {
          diagnostics.push(invalidReexport(ref.node, decl));
        } else {
          diagnostics.push(invalidRef(ref.node, decl, 'export'));
        }
        isPoisoned = true;
        continue;
      }
    }

    const exported: ScopeData = {
      directives: Array.from(exportDirectives.values()),
      pipes: Array.from(exportPipes.values()),
      ngModules: Array.from(exportedModules),
      isPoisoned,
    };

    const reexports = this.getReexports(ngModule, ref, declared, exported, diagnostics);


    // Finally, produce the `LocalModuleScope` with both the compilation and export scopes.
    const scope: LocalModuleScope = {
      ngModule: ngModule.ref.node,
      compilation: {
        directives: Array.from(compilationDirectives.values()),
        pipes: Array.from(compilationPipes.values()),
        ngModules: Array.from(compilationModules),
        isPoisoned,
      },
      exported,
      reexports,
      schemas: ngModule.schemas,
    };

    // Check if this scope had any errors during production.
    if (diagnostics.length > 0) {
      // Save the errors for retrieval.
      this.scopeErrors.set(ref.node, diagnostics);

      // Mark this module as being tainted.
      this.modulesWithStructuralErrors.add(ref.node);
    }

    this.cache.set(ref.node, scope);
    return scope;
  }

  /**
   * Check whether a component requires remote scoping.
   */
  getRemoteScope(node: ClassDeclaration): RemoteScope|null {
    return this.remoteScoping.has(node) ? this.remoteScoping.get(node)! : null;
  }

  /**
   * Set a component as requiring remote scoping, with the given directives and pipes to be
   * registered remotely.
   */
  setComponentRemoteScope(node: ClassDeclaration, directives: Reference[], pipes: Reference[]):
      void {
    this.remoteScoping.set(node, {directives, pipes});
  }

  /**
   * Look up the `ExportScope` of a given `Reference` to an NgModule.
   *
   * The NgModule in question may be declared locally in the current ts.Program, or it may be
   * declared in a .d.ts file.
   *
   * @returns `null` if no scope could be found, or `'invalid'` if the `Reference` is not a valid
   *     NgModule.
   *
   * May also contribute diagnostics of its own by adding to the given `diagnostics`
   * array parameter.
   */
  private getExportedScope(
      ref: Reference<ClassDeclaration>, diagnostics: ts.Diagnostic[],
      ownerForErrors: DeclarationNode, type: 'import'|'export'): ExportScope|null|'invalid' {
    if (ref.node.getSourceFile().isDeclarationFile) {
      // The NgModule is declared in a .d.ts file. Resolve it with the `DependencyScopeReader`.
      if (!ts.isClassDeclaration(ref.node)) {
        // The NgModule is in a .d.ts file but is not declared as a ts.ClassDeclaration. This is an
        // error in the .d.ts metadata.
        const code = type === 'import' ? ErrorCode.NGMODULE_INVALID_IMPORT :
                                         ErrorCode.NGMODULE_INVALID_EXPORT;
        diagnostics.push(makeDiagnostic(
            code, identifierOfNode(ref.node) || ref.node,
            `Appears in the NgModule.${type}s of ${
                nodeNameForError(ownerForErrors)}, but could not be resolved to an NgModule`));
        return 'invalid';
      }
      return this.dependencyScopeReader.resolve(ref);
    } else {
      // The NgModule is declared locally in the current program. Resolve it from the registry.
      return this.getScopeOfModuleReference(ref);
    }
  }

  private getReexports(
      ngModule: NgModuleMeta, ref: Reference<ClassDeclaration>, declared: Set<DeclarationNode>,
      exported: {directives: DirectiveMeta[], pipes: PipeMeta[]},
      diagnostics: ts.Diagnostic[]): Reexport[]|null {
    let reexports: Reexport[]|null = null;
    const sourceFile = ref.node.getSourceFile();
    if (this.aliasingHost === null) {
      return null;
    }
    reexports = [];
    // Track re-exports by symbol name, to produce diagnostics if two alias re-exports would share
    // the same name.
    const reexportMap = new Map<string, Reference<ClassDeclaration>>();
    // Alias ngModuleRef added for readability below.
    const ngModuleRef = ref;
    const addReexport = (exportRef: Reference<ClassDeclaration>) => {
      if (exportRef.node.getSourceFile() === sourceFile) {
        return;
      }
      const isReExport = !declared.has(exportRef.node);
      const exportName = this.aliasingHost!.maybeAliasSymbolAs(
          exportRef, sourceFile, ngModule.ref.node.name.text, isReExport);
      if (exportName === null) {
        return;
      }
      if (!reexportMap.has(exportName)) {
        if (exportRef.alias && exportRef.alias instanceof ExternalExpr) {
          reexports!.push({
            fromModule: exportRef.alias.value.moduleName!,
            symbolName: exportRef.alias.value.name!,
            asAlias: exportName,
          });
        } else {
          const expr =
              this.refEmitter.emit(exportRef.cloneWithNoIdentifiers(), sourceFile).expression;
          if (!(expr instanceof ExternalExpr) || expr.value.moduleName === null ||
              expr.value.name === null) {
            throw new Error('Expected ExternalExpr');
          }
          reexports!.push({
            fromModule: expr.value.moduleName,
            symbolName: expr.value.name,
            asAlias: exportName,
          });
        }
        reexportMap.set(exportName, exportRef);
      } else {
        // Another re-export already used this name. Produce a diagnostic.
        const prevRef = reexportMap.get(exportName)!;
        diagnostics.push(reexportCollision(ngModuleRef.node, prevRef, exportRef));
      }
    };
    for (const {ref} of exported.directives) {
      addReexport(ref);
    }
    for (const {ref} of exported.pipes) {
      addReexport(ref);
    }
    return reexports;
  }

  private assertCollecting(): void {
    if (this.sealed) {
      throw new Error(`Assertion: LocalModuleScopeRegistry is not COLLECTING`);
    }
  }
}

/**
 * Produce a `ts.Diagnostic` for an invalid import or export from an NgModule.
 */
function invalidRef(
    clazz: DeclarationNode, decl: Reference<DeclarationNode>,
    type: 'import'|'export'): ts.Diagnostic {
  const code =
      type === 'import' ? ErrorCode.NGMODULE_INVALID_IMPORT : ErrorCode.NGMODULE_INVALID_EXPORT;
  const resolveTarget = type === 'import' ? 'NgModule' : 'NgModule, Component, Directive, or Pipe';
  let message =
      `Appears in the NgModule.${type}s of ${
          nodeNameForError(clazz)}, but could not be resolved to an ${resolveTarget} class.` +
      '\n\n';
  const library = decl.ownedByModuleGuess !== null ? ` (${decl.ownedByModuleGuess})` : '';
  const sf = decl.node.getSourceFile();

  // Provide extra context to the error for the user.
  if (!sf.isDeclarationFile) {
    // This is a file in the user's program.
    const annotationType = type === 'import' ? '@NgModule' : 'Angular';
    message += `Is it missing an ${annotationType} annotation?`;
  } else if (sf.fileName.indexOf('node_modules') !== -1) {
    // This file comes from a third-party library in node_modules.
    message +=
        `This likely means that the library${library} which declares ${decl.debugName} has not ` +
        'been processed correctly by ngcc, or is not compatible with Angular Ivy. Check if a ' +
        'newer version of the library is available, and update if so. Also consider checking ' +
        'with the library\'s authors to see if the library is expected to be compatible with Ivy.';
  } else {
    // This is a monorepo style local dependency. Unfortunately these are too different to really
    // offer much more advice than this.
    message += `This likely means that the dependency${library} which declares ${
        decl.debugName} has not been processed correctly by ngcc.`;
  }

  return makeDiagnostic(code, identifierOfNode(decl.node) || decl.node, message);
}

/**
 * Produce a `ts.Diagnostic` for an import or export which itself has errors.
 */
function invalidTransitiveNgModuleRef(
    clazz: DeclarationNode, decl: Reference<DeclarationNode>,
    type: 'import'|'export'): ts.Diagnostic {
  const code =
      type === 'import' ? ErrorCode.NGMODULE_INVALID_IMPORT : ErrorCode.NGMODULE_INVALID_EXPORT;
  return makeDiagnostic(
      code, identifierOfNode(decl.node) || decl.node,
      `Appears in the NgModule.${type}s of ${nodeNameForError(clazz)}, but itself has errors`);
}

/**
 * Produce a `ts.Diagnostic` for an exported directive or pipe which was not declared or imported
 * by the NgModule in question.
 */
function invalidReexport(clazz: DeclarationNode, decl: Reference<DeclarationNode>): ts.Diagnostic {
  return makeDiagnostic(
      ErrorCode.NGMODULE_INVALID_REEXPORT, identifierOfNode(decl.node) || decl.node,
      `Present in the NgModule.exports of ${
          nodeNameForError(clazz)} but neither declared nor imported`);
}

/**
 * Produce a `ts.Diagnostic` for a collision in re-export names between two directives/pipes.
 */
function reexportCollision(
    module: ClassDeclaration, refA: Reference<ClassDeclaration>,
    refB: Reference<ClassDeclaration>): ts.Diagnostic {
  const childMessageText = `This directive/pipe is part of the exports of '${
      module.name.text}' and shares the same name as another exported directive/pipe.`;
  return makeDiagnostic(
      ErrorCode.NGMODULE_REEXPORT_NAME_COLLISION, module.name,
      `
    There was a name collision between two classes named '${
          refA.node.name.text}', which are both part of the exports of '${module.name.text}'.

    Angular generates re-exports of an NgModule's exported directives/pipes from the module's source file in certain cases, using the declared name of the class. If two classes of the same name are exported, this automatic naming does not work.

    To fix this problem please re-export one or both classes directly from this file.
  `.trim(),
      [
        makeRelatedInformation(refA.node.name, childMessageText),
        makeRelatedInformation(refB.node.name, childMessageText),
      ]);
}

export interface DeclarationData {
  ngModule: ClassDeclaration;
  ref: Reference;
  rawDeclarations: ts.Expression|null;
}
