use proc_macro::TokenStream;
use proc_macro2::Span;
use quote::{format_ident, quote};
use syn::{
    parse_macro_input, FnArg, GenericArgument, Ident, ItemFn, Pat, PathArguments, ReturnType, Type,
};

fn last_type_ident(ty: &Type) -> Option<&Ident> {
    match ty {
        Type::Path(path) => path.path.segments.last().map(|seg| &seg.ident),
        Type::Reference(reference) => last_type_ident(&reference.elem),
        Type::Group(group) => last_type_ident(&group.elem),
        _ => None,
    }
}

fn is_reference_type(ty: &Type) -> bool {
    matches!(ty, Type::Reference(_))
}

fn is_option_type(ty: &Type) -> bool {
    match ty {
        Type::Path(path) => path
            .path
            .segments
            .last()
            .is_some_and(|seg| seg.ident == "Option"),
        Type::Group(group) => is_option_type(&group.elem),
        _ => false,
    }
}

fn extract_state_inner(ty: &Type) -> Option<&Type> {
    let Type::Path(path) = ty else {
        return None;
    };
    let last = path.path.segments.last()?;
    if last.ident != "State" {
        return None;
    }
    let PathArguments::AngleBracketed(args) = &last.arguments else {
        return None;
    };
    args.args.iter().find_map(|arg| match arg {
        GenericArgument::Type(inner) => Some(inner),
        _ => None,
    })
}

fn returns_result(output: &ReturnType) -> bool {
    match output {
        ReturnType::Default => false,
        ReturnType::Type(_, ty) => last_type_ident(ty).is_some_and(|ident| ident == "Result"),
    }
}

/// Marks a command handler in `ecpa-core`, keeping the original function intact
/// while generating a companion `pub fn __ecpa_rpc_<name>` dispatcher that accepts
/// `(crate::runtime::AppHandle, serde_json::Value)` and returns
/// `crate::runtime::RpcFuture` (`Result<serde_json::Value, serde_json::Value>`).
///
/// Parameter resolution matches Tauri v2's default `#[tauri::command]` contract:
/// - `AppHandle` / `&AppHandle` is injected from the runtime context.
/// - `State<'_, T>` is extracted from `app.state::<T>()`.
/// - All remaining parameters are deserialized from the camelCase JSON object
///   payload (with `#[serde(default)]` applied automatically to `Option<T>`).
#[proc_macro_attribute]
pub fn ecpa_command(_attr: TokenStream, item: TokenStream) -> TokenStream {
    let input_fn = parse_macro_input!(item as ItemFn);
    let fn_ident = &input_fn.sig.ident;
    let rpc_ident = format_ident!("__ecpa_rpc_{}", fn_ident);
    let is_async = input_fn.sig.asyncness.is_some();
    let is_result = returns_result(&input_fn.sig.output);

    let mut arg_fields = Vec::new();
    let mut state_bindings = Vec::new();
    let mut call_args = Vec::new();

    for (index, input) in input_fn.sig.inputs.iter().enumerate() {
        let FnArg::Typed(pat_type) = input else {
            return syn::Error::new_spanned(input, "#[ecpa_command] does not support `self`")
                .to_compile_error()
                .into();
        };
        let ty = pat_type.ty.as_ref();

        if let Some(inner_ty) = extract_state_inner(ty) {
            let binding = format_ident!("__ecpa_state_{}", index);
            state_bindings.push(quote! {
                let #binding = __ecpa_app.state::<#inner_ty>();
            });
            call_args.push(quote! { #binding });
            continue;
        }

        if last_type_ident(ty).is_some_and(|ident| ident == "AppHandle") {
            if is_reference_type(ty) {
                call_args.push(quote! { &__ecpa_app });
            } else {
                call_args.push(quote! { __ecpa_app.clone() });
            }
            continue;
        }

        let ident = match pat_type.pat.as_ref() {
            Pat::Ident(pat_ident) => pat_ident.ident.clone(),
            other => {
                return syn::Error::new_spanned(
                    other,
                    "#[ecpa_command] requires simple identifier parameter patterns",
                )
                .to_compile_error()
                .into();
            }
        };

        let field_ident = Ident::new(&ident.to_string(), Span::call_site());
        if is_option_type(ty) {
            arg_fields.push(quote! {
                #[serde(default)]
                #field_ident: #ty
            });
        } else {
            arg_fields.push(quote! {
                #field_ident: #ty
            });
        }
        call_args.push(quote! { __ecpa_args.#field_ident });
    }

    let deserialize_block = if arg_fields.is_empty() {
        quote! { let _ = __ecpa_raw_args; }
    } else {
        quote! {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct __EcpaArgs {
                #(#arg_fields,)*
            }
            let __ecpa_payload = match __ecpa_raw_args {
                serde_json::Value::Null => serde_json::Value::Object(serde_json::Map::new()),
                other => other,
            };
            let __ecpa_args: __EcpaArgs = serde_json::from_value(__ecpa_payload)
                .map_err(|error| serde_json::Value::String(format!("Invalid command arguments: {error}")))?;
        }
    };

    let invocation = if is_async {
        quote! { #fn_ident(#(#call_args),*).await }
    } else {
        quote! { #fn_ident(#(#call_args),*) }
    };

    let convert_output = if is_result {
        quote! {
            match __ecpa_output {
                Ok(__value) => serde_json::to_value(__value)
                    .map_err(|error| serde_json::Value::String(error.to_string())),
                Err(__error) => Err(
                    serde_json::to_value(__error)
                        .unwrap_or_else(|error| serde_json::Value::String(error.to_string())),
                ),
            }
        }
    } else {
        quote! {
            serde_json::to_value(__ecpa_output)
                .map_err(|error| serde_json::Value::String(error.to_string()))
        }
    };

    let expanded = quote! {
        #input_fn

        #[doc(hidden)]
        pub(crate) fn #rpc_ident(
            __ecpa_app: crate::runtime::AppHandle,
            __ecpa_raw_args: serde_json::Value,
        ) -> crate::runtime::RpcFuture {
            Box::pin(async move {
                #deserialize_block
                #(#state_bindings)*
                let __ecpa_output = #invocation;
                #convert_output
            })
        }
    };

    TokenStream::from(expanded)
}
