# Client side data fetching and mutations

## Hooks

### useQuery

**Example**
```tsx

function Post() {
  const { data, loading, error, mutate } = useQuery('GET:/posts/:id', { params: { id: '1234' } })
  
  if(loading) {
    return <Skeleton/>
  }
  
  if(error) {
    return <Error />
  }
  
  return <PostCard post={data.post} />
}

```

The first argument is a unique string that defines the resource path. This path has an exact match with the route path when you define your api route. 

For example, an api route handles this request looks like this.

```ts

export default class extends ApiRouter {
  routes = {
    '/posts/:id': this.get((req) => {
      const post = await db.posts.findOne({ id: req.params.id })
      return { post }
    })
  }
}

```

The combination of the resource path and the `params` object creates a unique identifier for this resource. If you call `useQuery` hook in multiple places with the same resource path and params, they all will use the same result returned from the first called hook.

`useQuery` uses "stale-white-revalidate" approach for caching. When you fetch some data from the server and navigate to another page and come back, first the previously fetched data will be used but then it will be replaced with the fresh data once the new data is being loaded.



### useMutation

**Example**
```tsx

function CreatePost(props) {
  const { trigger, loading } = useMutation('POST:/posts');
  
  return (
    <button 
      disabled={loading} 
      onClick={() => trigger({ content: props.content })}
    >
     Create
    </button>
  )
  
}

```


## Components

### Form

Whereas `useMutation` is useful for simple cases, `Form` component is more versatile and more suitable when you need to send more data to your endpoint.

`Form` component automatically handles the validation errors and provides a simple api to render them.

**Example**

```tsx

function CreateProductForm() {
  return (
    <Form action="POST:/products">
      <FormField>
        <input name="title" class="group-data-[hasError=true]:border-red-500" />
        <ValidationError name="title" className="text-red-500" />
      </FormField>
     <FormField>
        <textarea name="description" class="group-data-[hasError=true]:border-red-500" />
        <ValidationError name="description" className="text-red-500" />
      </FormField>
      <SubmitButton className="bg-slate-700 text-white disabled:opacity-50">Submit</SubmitButton>    
    </Form>
  )
}

```


## Recipes
